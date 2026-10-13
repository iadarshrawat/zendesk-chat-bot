// Maintenance-only history processing; the application does not load this module at startup.
import { fetchTicket } from '../../../src/api/zendesk/tickets/index.js';
import { fetchConversationEvents } from '../../../src/api/zendesk/conversations/index.js';
import { readMonitoringIntentSessions, assignMonitoringIntent } from '../../../src/models/monitoring/intents/index.js';
import { SESSION_GAP_MS } from '../../../src/common/monitoring/validation/index.js';
import { safeErrorMetadata } from '../../../src/common/utils/timingLogger/index.js';
import { normalizeConversationEvents, detectMonitoringSessions } from '../../../src/services/monitoring/sessions/index.js';
import { resolveMonitoringIntent } from '../../../src/services/monitoring/intents/index.js';

/**
 * Reconstruct the original session evidence without allowing later replies to change its intent.
 * @param {Object} row - Pending SQL session and its original last-message timestamp.
 * @param {Object} ticket - Zendesk ticket metadata.
 * @param {Array<Object>} events - Current Zendesk conversation events.
 * @returns {Object} Ticket, original target session, and earlier messages; rejects if original evidence is missing.
 */
function historicalIntentContext(row, ticket, events) {
  const cutoff = new Date(row.last_message_at).getTime();
  if (!Number.isFinite(cutoff)) {
    throw new Error('Historical session has an invalid evidence cutoff');
  }
  const ticketMessages = normalizeConversationEvents(events, ticket.requester_id).filter(message => message.at <= cutoff);
  const session = detectMonitoringSessions(ticketMessages, SESSION_GAP_MS).find(
    candidate => candidate.firstMessageId === row.first_message_id
  );
  if (!session) {
    throw new Error('Original customer session is no longer available in Zendesk');
  }

  return { ticket, session, ticketMessages };
}

/**
 * Classify pending history, or explicitly revisit every saved session once, preserving satisfaction data.
 * @param {Object} options - SQL db, Zendesk client, allSessions, and optional onProgress callback.
 * @returns {Promise<Object>} Read, classified, unidentified, unchanged, and failed counts.
 */
export async function backfillMonitoringIntents({ db, client, allSessions = false, onProgress }) {
  const summary = { read: 0, classified: 0, unidentified: 0, unchanged: 0, failed: 0 };
  const options = { allSessions, before: allSessions ? new Date() : null };
  let after = '';
  while (true) {
    const rows = await readMonitoringIntentSessions(db, after, options);
    if (!rows.length) {
      return summary;
    }
    const tickets = new Map();
    for (const row of rows) {
      summary.read++;
      try {
        if (!tickets.has(row.ticket_id)) {
          tickets.set(
            row.ticket_id,
            (async () => {
              const response = await fetchTicket(client, row.ticket_id);
              if (!response.data?.ticket) {
                throw new Error('Historical ticket is unavailable');
              }
              const events = await fetchConversationEvents(client, row.ticket_id);

              return { ticket: response.data.ticket, events };
            })()
          );
        }
        const { ticket, events } = await tickets.get(row.ticket_id);
        const intentId = await resolveMonitoringIntent({ db, context: historicalIntentContext(row, ticket, events) });
        if (!intentId && row.intent_id) {
          // Missing evidence must not erase an already identified customer request.
          summary.unchanged++;
        } else {
          const written = await assignMonitoringIntent(db, row.session_id, intentId, { replaceExisting: allSessions });
          summary[written ? (intentId ? 'classified' : 'unidentified') : 'unchanged']++;
        }
      } catch (error) {
        summary.failed++;
        console.error('Historical intent classification failed', { sessionId: row.session_id, ...safeErrorMetadata(error) });
      }
      onProgress?.({ ...summary });
    }
    const next = rows.at(-1).session_id;
    if (!next || next <= after) {
      throw new Error('Intent backfill pagination did not advance');
    }
    after = next;
  }
}
