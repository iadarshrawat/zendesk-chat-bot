import { withZendeskRateLimitRetry } from './client.js';

/**
 * Read one cursor page of the incremental ticket export.
 * @param {Object} client - Authenticated Zendesk client.
 * @param {Object} params - Export start time or cursor and scope options.
 * @returns {Promise<Object>} The Axios response, after the existing 429 retries.
 */
export function fetchIncrementalTicketsPage(client, params) {
  return withZendeskRateLimitRetry(() => client.get('/incremental/tickets/cursor', { params }));
}

/**
 * Read one ticket for the monitoring preview.
 * @param {Object} client - Authenticated Zendesk client.
 * @param {string|number} ticketId - Zendesk ticket ID.
 * @returns {Promise<Object>} The Axios response, after the existing 429 retries.
 */
export function fetchTicket(client, ticketId) {
  return withZendeskRateLimitRetry(() => client.get(`/tickets/${ticketId}`));
}
