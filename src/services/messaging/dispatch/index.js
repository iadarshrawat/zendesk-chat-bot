import { handleHandoffEvent } from '../../escalation/index.js';
import { processCustomerMessage, loadCustomerContext } from '../events/index.js';
import { sendSunshineMessage } from '../messages/index.js';
import { customerMessages } from '../../../lib/message/index.js';
import { isAgentActive, shouldSkipMessage } from '../../../common/messaging/ownership/index.js';
import { runWithTrace, measureStage, safeErrorMetadata } from '../../../common/utils/timingLogger/index.js';
import { RAG_CONFIG } from '../../../config/rag/index.js';
import { createResponseBudget, runWithResponseBudget } from '../../../common/utils/responseBudget/index.js';
import {
  acceptsAgentOffer,
  cancelsAgentRequest,
  confirmsAgentRequest,
  needsFormHelp,
  asksHandoffStatus
} from '../../../common/messaging/handoff/index.js';
import { mightRequestHumanSupport } from '../../../common/messaging/intent/index.js';

/**
 * Allow speculative read-only context loading for ordinary text, avoiding obvious handoff-control turns.
 * @param {Object} message - Customer message with content and optional quick-reply payload.
 * @returns {boolean} Whether history/case reads can overlap the authoritative handoff check.
 */
function canPrefetchContext(message) {
  const text = message.content?.text || message.content?.markdownText || '';
  return (
    Boolean(text) &&
    message.content?.type !== 'formResponse' &&
    !acceptsAgentOffer(text) &&
    !cancelsAgentRequest(text, message.content?.payload) &&
    !confirmsAgentRequest(text, message.content?.payload) &&
    !needsFormHelp(text) &&
    !asksHandoffStatus(text) &&
    !mightRequestHumanSupport(text)
  );
}

/**
 * Route durable handoff state before normal answers and keep agent-owned conversations out of the bot.
 * @param {Object} event - Authenticated Sunshine customer event.
 * @returns {Promise<void>} Resolves after processing or a truthful status-unavailable reply.
 */
export async function processMessageEvent(event) {
  const conversation = event.payload?.conversation;
  const message = event.payload?.message;
  if (!conversation?.id || !message || shouldSkipMessage(message.author) || isAgentActive(conversation.activeSwitchboardIntegration))
    return;
  return runWithTrace({ route: 'inbox', fresh: true, traceId: message.id, messageId: message.id, conversationId: conversation.id }, () =>
    measureStage('turn.total', async () => {
      const budget = createResponseBudget({
        receivedAt: event._receivedAt || Date.now(),
        timeoutMs: RAG_CONFIG.conversation.responseHardTimeoutMs,
        targetMs: RAG_CONFIG.conversation.responseTargetMs,
        reserveMs: RAG_CONFIG.conversation.deliveryReserveMs
      });
      try {
        return await runWithResponseBudget(budget, async () => {
          // Observe speculative failures immediately; they only affect a turn that actually needs RAG.
          const preparedContext = canPrefetchContext(message)
            ? loadCustomerContext(event, conversation.id).then(
                value => ({ value }),
                error => ({ error })
              )
            : null;
          try {
            if (await handleHandoffEvent(event)) return;
          } catch (error) {
            if (error.deliveryUncertain) throw error;
            console.error('Handoff state unavailable', safeErrorMetadata(error));
            if (error.code === 'HANDOFF_CONFLICT') return;
            // An in-flight external transfer must be reconciled before any further customer-visible send.
            if (['transferring', 'transfer_unknown', 'transferred'].includes(event._handoff?.status)) throw error;
            await sendSunshineMessage(conversation.id, customerMessages.handoffUnavailable);
            return;
          }
          await processCustomerMessage(event, conversation.id, conversation.activeSwitchboardIntegration, {
            responseBudget: budget,
            preparedContext
          });
        });
      } finally {
        budget.dispose();
      }
    })
  );
}
