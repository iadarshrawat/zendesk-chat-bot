import {
  getConversationHistory,
  sendSunshineMessage,
  sendTypingIndicator,
} from "./messageGateway.js";
import { generateReplyWithClaude, getBrandFromWidgetId } from "./replyService.js";
import { customerMessages } from "./customerMessages.js";
import { saveForm, deleteForm } from "./conversationFormService.js";
import { isWithinBusinessHours } from "./businessHoursService.js";
import { RAG_CONFIG } from "../../config/rag.js";
import {
  loadConversationState,
  saveConversationState,
} from "./conversationStateService.js";
import { updateConversationState } from "./conversationContext.js";
import { isAgentActive } from "./conversationOwnership.js";
import { escalateToAgent } from "./escalationService.js";
import { logStage, measureStage, measureSyncStage, safeErrorMetadata } from "../../shared/timingLogger.js";
import {
  createResponseBudget,
  runWithResponseBudget,
  runWithDeadline,
  isResponseTimeout,
} from "../../shared/responseBudget.js";
import { formatCustomerReply } from "./customerReplyFormat.js";

const ignoreBestEffortFailure = () => undefined;

function generationFallback(error) {
  if (error.code === "SUPPORT_BRAND_NOT_CONFIGURED") {
    return {
      reason: "brand_not_configured",
      timeoutStage: undefined,
      result: {
        status: "insufficient",
        reply: customerMessages.brandUnknown,
      },
    };
  }

  if (isResponseTimeout(error)) {
    return {
      reason: "response_deadline",
      timeoutStage: error.timeoutStage || "operation",
      result: {
        status: "insufficient",
        reply: customerMessages.timeout,
      },
    };
  }

  return {
    reason: "generation_unavailable",
    timeoutStage: undefined,
    result: {
      status: "insufficient",
      reply: customerMessages.answerUnavailable,
    },
  };
}

function findFormField(fields, fieldName) {
  return fields.find((field) => field.name === fieldName) || null;
}

// Sunshine form fields have different value shapes for text, email, and select inputs.
function extractFormFieldValue(field) {
  if (!field) {
    return null;
  }

  const selectedOption = field.select && field.select[0];
  return field.email
    || field.text
    || field.value
    || (selectedOption && (selectedOption.value || selectedOption.email || selectedOption.name))
    || null;
}

function extractSelectedCategory(categoryField) {
  if (!categoryField) {
    return null;
  }
  if (Array.isArray(categoryField.select) && categoryField.select.length > 0) {
    return categoryField.select[0];
  }
  if (categoryField.value != null) {
    return categoryField.value;
  }
  if (categoryField.text != null) {
    return categoryField.text;
  }

  return categoryField;
}

/** Validate a submitted escalation form and continue the handoff flow. */
export async function handleFormResponse(event, conversationId, userName) {
  try {
    const fields = event.payload.message.content?.fields || [];
    logStage("escalation.form_fields", { fieldCount: fields.length });
    const author = event.payload.message.author;

    const customerName = extractFormFieldValue(findFormField(fields, "name"))
      || userName
      || "Customer";
    const customerEmail = extractFormFieldValue(findFormField(fields, "email"));
    if (!customerEmail) {
      throw new TypeError("Escalation form is missing an email address");
    }

    const selectedCategory = extractSelectedCategory(findFormField(fields, "category"));
    const issueCategoryId = selectedCategory?.value
      || selectedCategory?.id
      || selectedCategory?.group_id
      || selectedCategory?.groupId
      || selectedCategory?.name
      || (typeof selectedCategory === "string" ? selectedCategory : null);
    const issueCategoryName = selectedCategory?.label
      || selectedCategory?.name
      || (typeof selectedCategory === "string" ? selectedCategory : issueCategoryId)
      || "general";
    const issueDescription = findFormField(fields, "description")?.text
      || "No description provided";
    const webUserId = author.userId || event._webUserId || null;

    console.log("Received escalation form submission");

    const formData = {
      name: customerName,
      email: customerEmail,
      category: issueCategoryName,
      category_id: issueCategoryId,
      description: issueDescription,
      webUserId,
    };

    const { withinHours } = await measureStage(
      "escalation.business_hours",
      () => isWithinBusinessHours(),
    );
    logStage("escalation.business_hours_result", { withinHours });

    if (!withinHours) {
      console.log("Form submitted outside office hours - directly escalating and creating ticket");
      await measureStage(
        "escalation.handoff",
        () => escalateToAgent(conversationId, formData),
      );
      await deleteForm(conversationId, webUserId ? { webUserId } : {});
      return;
    }

    // Keep the form in process memory for office-hours confirmation.
    await saveForm(conversationId, {
      entryId: undefined,
      status: "form_submitted",
      data: formData,
      submittedAt: Date.now(),
      processing: false,
    });

    try {
      await sendSunshineMessage(conversationId, {
        text: customerMessages.formSubmitted(customerName, issueCategoryName),
        quickReplies: customerMessages.confirmationButtons,
      });
    } catch (error) {
      console.error("Failed to send form response message:", error.message);
      throw error;
    }
  } catch (error) {
    console.error("Error handling form response:", error.message);
    throw error;
  }
}

/** Check for either escalation button payload or its visible label. */
export function isEscalationRequest(messageBody) {
  return messageBody === "ESCALATE_TO_AGENT"
    || messageBody === customerMessages.confirmationButtons[0];
}

/** Check for either cancellation button payload or its visible label. */
export function isEscalationCancellation(messageBody) {
  return messageBody === "CANCEL_ESCALATION"
    || messageBody === customerMessages.confirmationButtons[1];
}

/** Injectable services let delivery ordering be verified without live providers. */
export function createCustomerMessageProcessor({
  resolveBrand = getBrandFromWidgetId,
  readHistory = getConversationHistory,
  sendTyping = sendTypingIndicator,
  generateReply = generateReplyWithClaude,
  loadState = loadConversationState,
  saveState = saveConversationState,
  sendReply = sendSunshineMessage,
} = {}) {
  return async function processCustomerMessage(
    event,
    conversationId,
    _conversationFormData,
    activeSwitchboardIntegration,
    queueContext = {},
  ) {
    if (isAgentActive(activeSwitchboardIntegration)) {
      logStage("turn.skipped", { reason: "agent_active" });
      return;
    }

    const message = event.payload.message;
    const messageBody = message.content?.text || message.content?.markdownText;
    const userId = message.author?.userId || null;
    let result;
    let state;
    let timeoutStage;
    let generationFailed = false;
    let typingStarted = Promise.resolve();
    let stateSave = Promise.resolve();

    const budget = queueContext.responseBudget || createResponseBudget({
      receivedAt: event._receivedAt || Date.now(),
      timeoutMs: RAG_CONFIG.conversation.responseHardTimeoutMs
        ?? RAG_CONFIG.conversation.responseTargetMs ?? 45_000,
      targetMs: RAG_CONFIG.conversation.responseTargetMs ?? 15_000,
      reserveMs: RAG_CONFIG.conversation.deliveryReserveMs ?? 4_000,
    });
    const deliveryTimeout = (timeoutMs) => Math.min(
      timeoutMs,
      budget.deliveryRemaining(),
    );

    logStage("turn.customer_input", {
      inputChars: typeof messageBody === "string" ? messageBody.length : 0,
    });
    logStage("turn.response_policy", {
      responseTargetMs: budget.responseTargetMs,
      responseHardTimeoutMs: budget.responseHardTimeoutMs,
      remainingMs: budget.remaining(),
    });

    try {
      await runWithResponseBudget(
        budget,
        () => runWithDeadline(async () => {
          budget.check();

          // Brand resolution must fail closed so one tenant never searches another tenant's data.
          const brand = measureSyncStage(
            "brand.resolve",
            () => resolveBrand(event.payload.conversation.brandId),
          );
          typingStarted = sendTyping(conversationId, "start", userId, {
            signal: budget.signal,
            timeoutMs: Math.min(
              budget.remaining(),
              RAG_CONFIG.conversation.typingTimeoutMs ?? 1_250,
            ),
          }).catch(ignoreBestEffortFailure);

          // These reads are independent, so run them while the typing request is in flight.
          const [history, previousState] = await measureStage(
            "turn.history_and_state",
            () => Promise.all([
              readHistory(conversationId, { beforeMessageId: message.id }),
              loadState(conversationId),
            ]),
          );

          budget.check();
          logStage("turn.history_loaded", { historyChars: history.length });
          state = previousState;
          result = await measureStage(
            "rag.total",
            () => generateReply(brand, history, messageBody, {
              conversationState: state,
              traceId: message.id,
              detailed: true,
            }),
          );
          budget.check();
        }, { signal: budget.signal, timeoutMs: budget.remaining() }),
      );
    } catch (error) {
      generationFailed = true;
      const fallback = generationFallback(error);
      timeoutStage = fallback.timeoutStage;

      logStage("turn.generation_fallback", {
        reason: fallback.reason,
        timeoutStage: error.timeoutStage,
        remainingMs: budget.remaining(),
      });
      console.error("Customer turn generation failed:", {
        messageId: message.id,
        error: error.message,
        timeoutStage: error.timeoutStage,
      });
      result = fallback.result;
    } finally {
      budget.cancel(generationFailed ? "generation_failed" : "generation_completed");
    }

    // Do not blindly retry an ambiguous POST failure: it may already be delivered.
    try {
      const displayReply = measureSyncStage(
        "turn.reply_format",
        () => formatCustomerReply(result.reply),
      );
      await sendReply(conversationId, { text: displayReply }, {
        timeoutMs: deliveryTimeout(RAG_CONFIG.conversation.sendTimeoutMs ?? 3000),
      });
      logStage("turn.answer_sent", { outcome: result.status, replyChars: displayReply.length });

      const summary = {
        outcome: result.status,
        replyChars: displayReply.length,
        durationMs: Date.now() - budget.receivedAt,
        targetExceeded: budget.targetExceeded(),
        processingMs: Date.now() - (event._receivedAt || budget.receivedAt),
        queueDelayMs: event._queueDelayMs,
        responseTargetMs: budget.responseTargetMs,
        responseHardTimeoutMs: budget.responseHardTimeoutMs,
        timeoutStage,
        ragElapsedMs: result.diagnostics?.elapsedMs,
        answerCalls: result.diagnostics?.answerCalls,
        citationRepairCalls: result.diagnostics?.citationRepairCalls,
      };
      logStage("turn.summary", summary);

      // One compact record survives detailed-trace disabling and console limits.
      // It contains no customer question, answer, manual, credentials or vectors.
      try {
        console.log("BOT TURN SUMMARY", JSON.stringify({ messageId: message.id, ...summary }));
      } catch {
        // A failed log writer must not break an already delivered turn.
      }

      if (state && result.plan) {
        stateSave = saveState(
          conversationId,
          updateConversationState(state, messageBody, result.plan, result, message.id),
          {
            timeoutMs: deliveryTimeout(RAG_CONFIG.conversation.stateSaveTimeoutMs ?? 1500),
          },
        ).catch((error) => {
          logStage("turn.state_save_failed", {
            reason: "state_persistence_unavailable",
            ...safeErrorMetadata(error),
          });
        });
      }
    } catch (error) {
      logStage("turn.delivery_failed", {
        reason: isResponseTimeout(error)
          ? "delivery_timeout_or_ambiguous"
          : "message_post_failed",
      });
      throw error;
    } finally {
      try {
        // Generation cancellation settles a pending typing-start. Stop cannot
        // overtake start, and cleanup runs even when delivery was uncertain.
        await typingStarted;
        await Promise.all([
          sendTyping(conversationId, "stop", userId, {
            timeoutMs: deliveryTimeout(RAG_CONFIG.conversation.typingStopTimeoutMs ?? 1500),
          }).catch(ignoreBestEffortFailure),
          stateSave,
        ]);
      } finally {
        budget.dispose();
      }
    }
  };
}

/** Process one customer turn after the in-memory inbox has claimed it. */
export const processCustomerMessage = createCustomerMessageProcessor();
