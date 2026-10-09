import { withZendeskRateLimitRetry } from './client.js';

/**
 * Read every conversation-log page in chronological order, checking cursor progress.
 * @param {Object} client - Authenticated Zendesk client.
 * @param {string|number} ticketId - Zendesk ticket ID.
 * @returns {Promise<Array>} Raw conversation events; throws on a stalled cursor.
 */
export async function fetchConversationEvents(client, ticketId) {
  const events = [];
  let cursor = null;

  do {
    const params = { sort: 'created_at', 'page[size]': 100 };
    if (cursor) {
      params['page[after]'] = cursor;
    }

    const response = await withZendeskRateLimitRetry(() => client.get(`/tickets/${ticketId}/conversation_log`, { params }));
    events.push(...(response.data.events || []));

    if (!response.data.meta?.has_more) {
      break;
    }

    const nextCursor = response.data.meta.after_cursor;
    if (!nextCursor || nextCursor === cursor) {
      throw new Error(`Conversation log cursor stalled for ticket ${ticketId}`);
    }

    cursor = nextCursor;
  } while (true);

  return events;
}
