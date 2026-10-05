import {
  handleEscalateToAgent,
  handleCancelEscalation,
  handleEscalationCheck,
} from "./escalationService.js";
import {
  handleFormResponse,
  isEscalationRequest,
  isEscalationCancellation,
  processCustomerMessage,
} from "./eventHandlers.js";
import { isAgentActive, shouldSkipMessage } from "./conversationOwnership.js";
import { runWithTrace, measureStage } from "../../shared/timingLogger.js";

const CUSTOMER_AUTHOR_TYPES = ["user", "end_user"];

export async function processMessageEvent(event) {
  const conversation = event.payload?.conversation;
  const message = event.payload?.message;

  const shouldIgnoreEvent = !conversation?.id
    || !message
    || shouldSkipMessage(message.author)
    || isAgentActive(conversation.activeSwitchboardIntegration)
    || !CUSTOMER_AUTHOR_TYPES.includes(message.author?.type);

  if (shouldIgnoreEvent) {
    return;
  }

  const conversationId = conversation.id;
  const text = message.content?.text || message.content?.markdownText;
  const webUserId = message.author?.userId || null;
  event._webUserId = webUserId;

  const trace = {
    route: "inbox",
    fresh: true,
    traceId: message.id,
    messageId: message.id,
    conversationId,
  };

  return runWithTrace(trace, () => measureStage("turn.total", async () => {
    if (message.content?.type === "formResponse" && message.content.fields) {
      return handleFormResponse(
        event,
        conversationId,
        message.author?.displayName || "Customer",
      );
    }
    if (!text) {
      return;
    }
    if (isEscalationRequest(text)) {
      return handleEscalateToAgent(conversationId, webUserId);
    }
    if (isEscalationCancellation(text)) {
      return handleCancelEscalation(conversationId, webUserId);
    }

    let escalationHandled = false;
    try {
      escalationHandled = await handleEscalationCheck({
        conversationId,
        messageBody: text,
        userName: message.author?.displayName || "Customer",
        webUserId,
      });
    } catch (error) {
      if (error.deliveryUncertain) {
        throw error;
      }
      console.warn("Escalation classification unavailable", error.message);
    }

    if (!escalationHandled) {
      await processCustomerMessage(
        event,
        conversationId,
        null,
        conversation.activeSwitchboardIntegration,
      );
    }
  }));
}
