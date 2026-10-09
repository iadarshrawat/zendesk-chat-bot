import { createClaudeClient } from './client.js';

/**
 * Request a Claude SDK message with the caller's deadline and retry policy.
 * @param {Object} client - Anthropic SDK client.
 * @param {Object} payload - Model, prompts, and output options.
 * @param {Object} options - timeoutMs, maxRetries, and optional signal.
 * @returns {Promise<Object>} The unmodified SDK message response.
 */
export function createClaudeMessage(client, payload, { timeoutMs, maxRetries, signal }) {
  return client.messages.create(payload, {
    timeout: timeoutMs,
    maxRetries,
    ...(signal ? { signal } : {})
  });
}

/**
 * Send a monitoring evaluation using its existing REST transport.
 * @param {Object} payload - Model and evaluation prompts.
 * @returns {Promise<Object>} The unmodified Axios response.
 */
export function requestMonitoringEvaluation(payload) {
  return createClaudeClient().post('/messages', payload);
}
