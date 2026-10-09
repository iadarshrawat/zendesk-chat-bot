import { requestOptions } from '../index.js';

/**
 * Post a text or form payload to a Sunshine conversation.
 * @param {Object} client - Authenticated Sunshine client.
 * @param {string} conversationId - Conversation ID.
 * @param {Object} payload - Message author and content.
 * @param {Array<Object>} options - Optional Axios request arguments.
 * @returns {Promise<Object>} The unmodified Axios response.
 */
export function postConversationMessage(client, conversationId, payload, options = []) {
  return client.post(`/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`, payload, ...options);
}

/**
 * Post a start or stop typing activity.
 * @param {Object} client - Authenticated Sunshine client.
 * @param {string} conversationId - Conversation ID.
 * @param {Object} payload - Activity author and type.
 * @param {Object} options - Optional signal and timeoutMs.
 * @returns {Promise<Object>} The unmodified Axios response.
 */
export function postConversationActivity(client, conversationId, payload, { signal, timeoutMs }) {
  return client.post(
    `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/activity`,
    payload,
    ...requestOptions(signal, timeoutMs)
  );
}

/**
 * Read the latest message page without adding a pagination request.
 * @param {Object} client - Authenticated Sunshine client.
 * @param {string} conversationId - Conversation ID.
 * @param {Object} options - Optional signal and timeoutMs.
 * @returns {Promise<Object>} The unmodified Axios response.
 */
export function fetchConversationMessages(client, conversationId, { signal, timeoutMs }) {
  return client.get(`/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`, ...requestOptions(signal, timeoutMs));
}

/**
 * Hand a conversation to Zendesk Agent Workspace with the captured form details.
 * @param {Object} client - Authenticated Sunshine client.
 * @param {string} conversationId - Conversation ID.
 * @param {Object} metadata - Existing data-capture metadata.
 * @returns {Promise<Object>} The unmodified passControl Axios response.
 */
export function passConversationControl(client, conversationId, metadata) {
  return client.post(`/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/passControl`, {
    switchboardIntegration: 'zd-agentWorkspace',
    metadata
  });
}

/**
 * Mark failures that may have occurred after message delivery for inbox quarantine.
 * @param {Error} error - Original delivery error, kept intact for callers.
 * @returns {void} Sets the existing deliveryUncertain flag on the error.
 */
export function markDeliveryUncertain(error) {
  error.deliveryUncertain = !error.response || error.response.status >= 500;
}
