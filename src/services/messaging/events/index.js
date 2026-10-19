import { getConversationHistory, sendSunshineMessage, sendTypingIndicator } from '../messages/index.js';
import { generateReplyWithClaude, getBrandFromWidgetId } from '../../rag/replies/index.js';
import { customerMessages } from '../../../lib/message/index.js';
import { RAG_CONFIG } from '../../../config/rag/index.js';
import { loadConversationState, saveConversationState } from '../../../models/conversationState/index.js';
import { updateConversationState } from '../../../common/messaging/context/index.js';
import { isAgentActive } from '../../../common/messaging/ownership/index.js';
import { prepareHandoffReply, confirmHandoffReply } from '../../escalation/index.js';
import { logStage, measureStage, measureSyncStage, safeErrorMetadata } from '../../../common/utils/timingLogger/index.js';
import {
  createResponseBudget,
  runWithResponseBudget,
  runWithDeadline,
  isResponseTimeout
} from '../../../common/utils/responseBudget/index.js';
import { formatCustomerReply } from '../../../common/messaging/replyFormat/index.js';

const ignoreBestEffortFailure = () => undefined;

/**
 * Start independent history and case reads only after validating the conversation's brand mapping.
 * @param {Object} event - Current authenticated customer event.
 * @param {string} conversationId - Conversation owning both reads.
 * @returns {Promise<Array>} Earlier conversation text and saved case state.
 */
export async function loadCustomerContext(event, conversationId) {
  getBrandFromWidgetId(event.payload.conversation.brandId);
  return measureStage('turn.history_and_state', () =>
    Promise.all([
      getConversationHistory(conversationId, { beforeMessageId: event.payload.message.id }),
      loadConversationState(conversationId)
    ])
  );
}

/**
 * Choose the existing safe customer reply for a deadline, unavailable generation, or missing evidence.
 * @param {Error} error - Original failure to inspect or handle.
 * @returns {Object} The fallback reply and existing status metadata.
 */
function generationFallback(error) {
  if (error.code === 'SUPPORT_BRAND_NOT_CONFIGURED') {
    return {
      reason: 'brand_not_configured',
      timeoutStage: undefined,
      result: {
        status: 'insufficient',
        offerAgent: true,
        reply: customerMessages.brandUnknown
      }
    };
  }

  if (isResponseTimeout(error)) {
    return {
      reason: 'response_deadline',
      timeoutStage: error.timeoutStage || 'operation',
      result: {
        status: 'insufficient',
        offerAgent: true,
        reply: customerMessages.timeout
      }
    };
  }

  return {
    reason: 'generation_unavailable',
    timeoutStage: undefined,
    result: {
      status: 'insufficient',
      offerAgent: true,
      reply: customerMessages.answerUnavailable
    }
  };
}

/**
 * Process one customer turn with saved context, grounded generation, delivery, and state persistence.
 * @param {Object} event - Sunshine webhook event.
 * @param {string} conversationId - Sunshine conversation ID.
 * @param {Object|string} activeSwitchboardIntegration - Integration currently owning the conversation.
 * @param {Object} queueContext - Optional shared response budget and observed prefetched context result.
 * @returns {Promise<void>} Resolves after processing; propagates failures according to the existing inbox policy.
 */
export async function processCustomerMessage(event, conversationId, activeSwitchboardIntegration, queueContext = {}) {
  if (isAgentActive(activeSwitchboardIntegration)) {
    logStage('turn.skipped', { reason: 'agent_active' });

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

  const budget =
    queueContext.responseBudget ||
    createResponseBudget({
      receivedAt: event._receivedAt || Date.now(),
      timeoutMs: RAG_CONFIG.conversation.responseHardTimeoutMs ?? RAG_CONFIG.conversation.responseTargetMs ?? 45_000,
      targetMs: RAG_CONFIG.conversation.responseTargetMs ?? 15_000,
      reserveMs: RAG_CONFIG.conversation.deliveryReserveMs ?? 4_000
    });
  const deliveryTimeout = timeoutMs => Math.min(timeoutMs, budget.deliveryRemaining());

  logStage('turn.customer_input', {
    inputChars: typeof messageBody === 'string' ? messageBody.length : 0
  });
  logStage('turn.response_policy', {
    responseTargetMs: budget.responseTargetMs,
    responseHardTimeoutMs: budget.responseHardTimeoutMs,
    remainingMs: budget.remaining()
  });

  try {
    await runWithResponseBudget(budget, () =>
      runWithDeadline(
        async () => {
          budget.check();

          // Brand resolution must fail closed so one tenant never searches another tenant's data.
          const brand = measureSyncStage('brand.resolve', () => getBrandFromWidgetId(event.payload.conversation.brandId));
          typingStarted = sendTypingIndicator(conversationId, 'start', userId, {
            signal: budget.signal,
            timeoutMs: Math.min(budget.remaining(), RAG_CONFIG.conversation.typingTimeoutMs ?? 1_250)
          }).catch(ignoreBestEffortFailure);

          // These reads are independent, so run them while the typing request is in flight.
          const prefetched = queueContext.preparedContext ? await queueContext.preparedContext : null;
          if (prefetched?.error) throw prefetched.error;
          const [history, previousState] = prefetched ? prefetched.value : await loadCustomerContext(event, conversationId);

          budget.check();
          logStage('turn.history_loaded', { historyChars: history.length });
          state = previousState;
          result = await measureStage('rag.total', () =>
            generateReplyWithClaude(brand, history, messageBody, {
              conversationState: state,
              handoffStatus: event._handoff?.status || 'none',
              traceId: message.id,
              detailed: true
            })
          );
          budget.check();
        },
        { signal: budget.signal, timeoutMs: budget.remaining() }
      )
    );
  } catch (error) {
    generationFailed = true;
    const fallback = generationFallback(error);
    timeoutStage = fallback.timeoutStage;

    logStage('turn.generation_fallback', {
      reason: fallback.reason,
      timeoutStage: error.timeoutStage,
      remainingMs: budget.remaining()
    });
    console.error('Customer turn generation failed:', {
      messageId: message.id,
      error: error.message,
      timeoutStage: error.timeoutStage
    });
    result = fallback.result;
  } finally {
    budget.cancel(generationFailed ? 'generation_failed' : 'generation_completed');
  }

  // Do not blindly retry an ambiguous POST failure: it may already be delivered.
  try {
    const outgoing = await prepareHandoffReply(event, result);
    const displayReply = measureSyncStage('turn.reply_format', () => formatCustomerReply(result.reply));
    const delivered = await sendSunshineMessage(
      conversationId,
      { ...outgoing, text: displayReply },
      {
        timeoutMs: deliveryTimeout(RAG_CONFIG.conversation.sendTimeoutMs ?? 3000)
      }
    );
    await confirmHandoffReply(event, delivered);
    logStage('turn.answer_sent', {
      outcome: result.status,
      replyChars: displayReply.length
    });

    const summary = {
      outcome: result.status,
      replyChars: displayReply.length,
      durationMs: Date.now() - budget.receivedAt,
      targetExceeded: budget.targetExceeded(),
      processingMs: Date.now() - (event._receivedAt || budget.receivedAt),
      sinceWebhookMs: Date.now() - budget.receivedAt + (event._queueDelayMs || 0),
      queueDelayMs: event._queueDelayMs,
      responseTargetMs: budget.responseTargetMs,
      responseHardTimeoutMs: budget.responseHardTimeoutMs,
      timeoutStage,
      ragElapsedMs: result.diagnostics?.elapsedMs,
      answerCalls: result.diagnostics?.answerCalls,
      citationRepairCalls: result.diagnostics?.citationRepairCalls
    };
    logStage('turn.summary', summary);

    // One compact record survives detailed-trace disabling and console limits.
    // It contains no customer question, answer, manual, credentials or vectors.
    try {
      console.log('BOT TURN SUMMARY', JSON.stringify({ messageId: message.id, ...summary }));
    } catch {
      // A failed log writer must not break an already delivered turn.
    }

    if (state && result.plan) {
      stateSave = saveConversationState(conversationId, updateConversationState(state, messageBody, result.plan, result, message.id), {
        timeoutMs: deliveryTimeout(RAG_CONFIG.conversation.stateSaveTimeoutMs ?? 1500)
      }).catch(error => {
        logStage('turn.state_save_failed', {
          reason: 'state_persistence_unavailable',
          ...safeErrorMetadata(error)
        });
      });
    }
  } catch (error) {
    logStage('turn.delivery_failed', {
      reason: isResponseTimeout(error) ? 'delivery_timeout_or_ambiguous' : 'message_post_failed'
    });
    throw error;
  } finally {
    try {
      // Generation cancellation settles a pending typing-start. Stop cannot
      // overtake start, and cleanup runs even when delivery was uncertain.
      await typingStarted;
      await Promise.all([
        sendTypingIndicator(conversationId, 'stop', userId, {
          timeoutMs: deliveryTimeout(RAG_CONFIG.conversation.typingStopTimeoutMs ?? 1500)
        }).catch(ignoreBestEffortFailure),
        stateSave
      ]);
    } finally {
      if (!queueContext.responseBudget) budget.dispose();
    }
  }
}
