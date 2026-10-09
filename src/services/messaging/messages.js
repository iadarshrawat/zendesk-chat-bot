import { createSunshineClient } from '../../api/sunshine/client.js';
import {
  postConversationMessage,
  postConversationActivity,
  fetchConversationMessages,
  markDeliveryUncertain
} from '../../api/sunshine/conversations.js';
import { requestOptions } from '../../api/index.js';
import { RAG_CONFIG } from '../../config/rag.js';
import { checkResponseBudget, getResponseBudget, runBudgetedIO, runWithDeadline } from '../../common/utils/responseBudget.js';
import { startStage } from '../../common/utils/timingLogger.js';
import { getSupportBrandByWidgetId } from '../../config/brands.js';
import { customerMessages } from '../../lib/message/index.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const IGNORED_HISTORY_MESSAGE = 'What would you like to know next?';

/**
 * Build the existing business-authored text payload and optional quick-reply actions.
 * @param {string|Object} message - Text or the existing structured customer message.
 * @returns {Object} The Sunshine message payload with unchanged quick-reply identifiers.
 */
function buildTextMessage(message) {
  const text = typeof message === 'string' ? message : message.text;
  const quickReplies = typeof message === 'object' ? message.quickReplies : null;
  const hasQuickReplies = quickReplies && quickReplies.length > 0;
  const actions = hasQuickReplies
    ? quickReplies.map(quickReply => ({
        type: 'reply',
        text: quickReply,
        payload: quickReply.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
      }))
    : null;

  return {
    author: { type: 'business' },
    content: {
      type: 'text',
      markdownText: text,
      ...(hasQuickReplies && { actions })
    }
  };
}

/**
 * Send text or quick replies within the caller's deadline and mark uncertain delivery for quarantine.
 * @param {string} conversationId - Sunshine conversation ID.
 * @param {string|Object} message - Text or the existing structured customer message.
 * @param {Object} options - Optional timeoutMs and cancellation signal for delivery.
 * @returns {Promise<Object>} The Sunshine response data; propagates the original delivery error.
 */
export async function sendSunshineMessage(conversationId, message, options = {}) {
  const span = startStage('sunshine.message_send', {
    conversationId,
    replyChars: typeof message === 'string' ? message.length : message?.text?.length || 0,
    timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  });

  try {
    if (!process.env.SUNSHINE_APP_ID) {
      throw new Error('SUNSHINE_APP_ID not configured in .env');
    }

    const sunshineClient = createSunshineClient();
    const payload = buildTextMessage(message);
    const response = await runWithDeadline(
      ({ signal, timeoutMs }) => postConversationMessage(sunshineClient, conversationId, payload, requestOptions(signal, timeoutMs)),
      options
    );

    span.end({ httpStatus: response.status });

    return response.data;
  } catch (error) {
    span.fail(error);
    // A POST without a definitive response may already have been delivered.
    // The inbox must quarantine it instead of automatically posting twice.
    markDeliveryUncertain(error);
    console.error('Failed to send Sunshine message', {
      status: error.response?.status,
      message: error.message
    });
    throw error;
  }
}

/**
 * Resolve the conversation's support brand and send its existing welcome text.
 * @param {Object} event - Sunshine webhook event.
 * @returns {Promise<Object>} The delivered welcome message response.
 */
export async function sendWelcomeMessage(event) {
  const conversationId = event.payload?.conversation?.id;
  const brand = getSupportBrandByWidgetId(event.payload?.conversation?.brandId);

  return sendSunshineMessage(conversationId, customerMessages.welcome(brand.displayName));
}

/**
 * Send a form with the existing timeout and uncertain-delivery marking.
 * @param {string} conversationId - Sunshine conversation ID.
 * @param {Array<Object>} fields - Existing Sunshine form fields.
 * @param {Object} options - Optional timeoutMs for form delivery.
 * @returns {Promise<Object>} The Sunshine response data; rejects on a form-delivery failure.
 */
export async function sendSunshineForm(conversationId, fields, options = {}) {
  const client = createSunshineClient();

  try {
    const response = await postConversationMessage(
      client,
      conversationId,
      {
        author: { type: 'business' },
        content: {
          type: 'form',
          text: customerMessages.formPrompt,
          fields
        }
      },
      [{ timeout: options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS }]
    );

    return response.data;
  } catch (error) {
    markDeliveryUncertain(error);
    throw error;
  }
}

/**
 * Send the start or stop activity while treating typing failures as non-fatal.
 * @param {string} conversationId - Sunshine conversation ID.
 * @param {string|boolean} state - start or stop; true and false retain compatibility.
 * @param {string|null} _userId - Unused compatibility argument; activities remain business-authored.
 * @param {Object} options - Optional timeoutMs and cancellation signal for the activity.
 * @returns {Promise<Object|null>} Activity response data, or null when the activity could not be sent.
 */
export async function sendTypingIndicator(conversationId, state = 'start', _userId = null, options = {}) {
  const isStarting = state === true || state === 'start';
  const span = startStage(isStarting ? 'sunshine.typing_start' : 'sunshine.typing_stop', {
    conversationId,
    timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  });

  try {
    if (!process.env.SUNSHINE_APP_ID) {
      throw new Error('SUNSHINE_APP_ID not configured in .env');
    }

    const sunshineClient = createSunshineClient();
    const activityType = isStarting ? 'typing:start' : 'typing:stop';
    const payload = {
      author: { type: 'business' },
      type: activityType
    };

    const response = await runWithDeadline(
      ({ signal, timeoutMs }) =>
        postConversationActivity(sunshineClient, conversationId, payload, {
          signal,
          timeoutMs
        }),
      options
    );

    span.end({ httpStatus: response.status });

    return response.data;
  } catch (error) {
    span.fail(error);
    console.warn('Failed to send typing indicator:', error.response?.status, error.message);

    return null;
  }
}

/**
 * Read only earlier conversation text and retain the configured history-message and character limits.
 * @param {string} conversationId - Sunshine conversation ID.
 * @param {Object} options - Options: beforeMessageId.
 * @returns {Promise<string>} Safe recent conversation text, or the existing empty fallback on fetch failure.
 */
export async function getConversationHistory(conversationId, { beforeMessageId = null } = {}) {
  const span = startStage('sunshine.history', {
    conversationId,
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS
  });

  try {
    const client = createSunshineClient();
    const timeoutMs = getResponseBudget() ? (RAG_CONFIG.conversation?.historyTimeoutMs ?? 1500) : DEFAULT_REQUEST_TIMEOUT_MS;
    const response = await runBudgetedIO(
      ({ signal, timeoutMs: boundedTimeoutMs }) =>
        fetchConversationMessages(client, conversationId, {
          signal,
          timeoutMs: boundedTimeoutMs
        }),
      timeoutMs
    );

    let messages = Array.isArray(response.data.messages) ? response.data.messages : [];
    const currentIndex = beforeMessageId ? messages.findIndex(message => message.id === beforeMessageId) : -1;

    if (beforeMessageId && currentIndex < 0) {
      // Old queued messages may be outside the API's most recent page. Saved
      // case state is safer than mixing later messages into this earlier turn.
      console.warn('Current message absent from history page; using saved case state', beforeMessageId);
      span.end({ outcome: 'current_message_not_in_page', historyChars: 0 });

      return '';
    }

    if (currentIndex >= 0) {
      messages = messages.slice(0, currentIndex);
    }

    const history = messages
      .filter(message => {
        const text = message.content?.text || message.content?.markdownText;
        if (typeof text !== 'string' || !text.trim()) {
          return false;
        }

        return !(message.author?.type === 'business' && text === IGNORED_HISTORY_MESSAGE);
      })
      .slice(-RAG_CONFIG.conversation.historyMessages)
      .map(message => {
        const role = message.author?.type === 'business' ? 'Bot' : 'User';

        return `${role}: ${message.content.text || message.content.markdownText}`;
      })
      .join('\n')
      .slice(-16_000);

    span.end({ httpStatus: response.status, historyChars: history.length });

    return history;
  } catch (error) {
    span.fail(error);
    checkResponseBudget();
    console.error('History fetch failed:', error.message);

    return '';
  }
}
