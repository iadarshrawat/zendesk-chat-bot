import { CLAUDE_CONFIG } from '../../../config/claude/index.js';
import { fetchIncrementalTicketsPage } from '../../../api/zendesk/tickets/index.js';
import { fetchConversationEvents } from '../../../api/zendesk/conversations/index.js';
import { createZendeskClient } from '../../../api/zendesk/client/index.js';
import { getPool } from '../../../loaders/database/sql/index.js';
import { completedSessionIds, saveMonitoringSession } from '../../../models/monitoring/index.js';
import { SESSION_GAP_MS } from '../../../common/monitoring/validation/index.js';
import { evaluateSession, sessionEvaluationRecord } from '../evaluation/index.js';
import { detectMonitoringSessions, monitoringSessionId, normalizeConversationEvents } from '../sessions/index.js';
import { resolveMonitoringIntent } from '../intents/index.js';
import { safeErrorMetadata } from '../../../common/utils/timingLogger/index.js';

const LOOKBACK_MS = 5 * 60 * 60 * 1000;

/**
 * Collect and deduplicate exported tickets updated inside the existing five-hour lookback window.
 * @param {Object} client - Authenticated provider client.
 * @param {number} now - Current Unix timestamp in milliseconds.
 * @returns {Promise<Array<Object>>} Eligible updated tickets; rejects when the export cursor stalls.
 */
async function fetchUpdatedTickets(client, now) {
  const windowStart = now - LOOKBACK_MS;
  const startTime = Math.floor(windowStart / 1000);
  const ticketsById = new Map();
  let cursor = null;

  do {
    const params = cursor
      ? {
          cursor,
          support_type_scope: 'all',
          exclude_deleted: true,
          per_page: 1000
        }
      : {
          start_time: startTime,
          support_type_scope: 'all',
          exclude_deleted: true,
          per_page: 1000
        };

    const response = await fetchIncrementalTicketsPage(client, params);

    for (const ticket of response.data.tickets || []) {
      const updatedAt = Date.parse(ticket.updated_at);
      const isInLookbackWindow = Number.isFinite(updatedAt) && updatedAt >= windowStart && updatedAt <= now;

      if (isInLookbackWindow) {
        ticketsById.set(String(ticket.id), ticket);
      }
    }

    if (response.data.end_of_stream) {
      break;
    }

    const nextCursor = response.data.after_cursor;
    if (!nextCursor || nextCursor === cursor) {
      throw new Error('Zendesk ticket export did not advance its cursor');
    }

    cursor = nextCursor;
  } while (true);

  return [...ticketsById.values()];
}

/**
 * Detect due AI sessions and save only sessions not already completed in SQL.
 * @param {Object} client - Authenticated provider client.
 * @param {Object} db - SQL connection pool.
 * @param {Object} ticket - Zendesk ticket metadata.
 * @param {number} now - Evaluation time as a Unix timestamp in milliseconds.
 * @returns {Promise<Array<Object>>} Newly persisted session evaluation results for the ticket.
 */
async function processTicket(client, db, ticket, now) {
  const events = await fetchConversationEvents(client, ticket.id);
  const hasMessagingEvents = events.some(event => event.type === 'Messaging::ConversationMessage');
  if (!hasMessagingEvents) {
    return [];
  }

  const messages = normalizeConversationEvents(events, ticket.requester_id);

  // The five-hour export can include unrelated support tickets. Only assess
  // conversations involving an AI/bot or a known bot handoff.
  const hasBotMessage = messages.some(message => message.speaker === 'Bot');
  const involvesAi = hasBotMessage || ticket.support_type === 'ai_agent' || ticket.tags?.includes('escalated_to_agent');
  if (!involvesAi) {
    return [];
  }

  const sessions = detectMonitoringSessions(messages, SESSION_GAP_MS);
  if (!sessions.length) {
    return [];
  }

  const dueSessions = sessions.filter(session => session.lastCustomerAt + SESSION_GAP_MS <= now);
  if (!dueSessions.length) {
    return [];
  }

  const completedIds = await completedSessionIds(db, ticket.id);
  const allDueSessionsAreComplete = dueSessions.every(session => completedIds.has(monitoringSessionId(ticket.id, session)));
  if (allDueSessionsAreComplete) {
    return [];
  }

  const results = [];
  for (const session of dueSessions) {
    const sessionId = monitoringSessionId(ticket.id, session);

    if (completedIds.has(sessionId)) {
      continue;
    }

    const evaluation = { ...(await evaluateSession(ticket, session, messages)) };
    try {
      evaluation.intent_id = await resolveMonitoringIntent({
        db,
        context: { ticket, session, ticketMessages: messages },
        draft: evaluation.customer_intent
      });
    } catch (error) {
      // Preserve a valid satisfaction evaluation; the backfill can retry this pending intent.
      evaluation.intent_id = null;
      evaluation.intent_classified_at = null;
      console.warn('Monitoring customer intent remains pending', {
        ticketId: String(ticket.id),
        session: session.number,
        ...safeErrorMetadata(error)
      });
    }

    const saved = await saveMonitoringSession(db, sessionEvaluationRecord(ticket, session, evaluation, now));
    if (!saved) {
      continue;
    }
    completedIds.add(sessionId);

    results.push({
      ticket_id: ticket.id,
      session_number: session.number,
      ...evaluation
    });
  }

  return results;
}

/**
 * Count evaluated session outcomes and polling errors using the existing monitoring summary fields.
 * @param {Array<Object>} tickets - Tickets considered by the monitoring poll.
 * @param {Array<Object>} results - Completed session evaluation results.
 * @param {Array} errors - Existing polling or retrieval failures.
 * @returns {Object} The monitoring poll summary.
 */
function summarizeResults(tickets, results, errors) {
  const scoreBreakdown = {
    satisfied: 0,
    neutral: 0,
    unsatisfied: 0,
    escalated: 0,
    insufficient_data: 0
  };
  for (const result of results) {
    scoreBreakdown[result.customer_satisfaction]++;
  }

  return {
    total_tickets: tickets.length,
    evaluated_sessions: results.length,
    score_breakdown: scoreBreakdown,
    errors: errors.length
  };
}

/**
 * Poll updated tickets, evaluate due sessions, and preserve per-ticket failure isolation.
 * @returns {Promise<Object>} The existing success flag, summary, results, and errors.
 */
export async function runReport() {
  const now = Date.now();
  if (!CLAUDE_CONFIG.apiKey) {
    return { success: false, error: 'Missing Claude credentials' };
  }

  try {
    const client = await createZendeskClient();
    const db = getPool();

    const tickets = await fetchUpdatedTickets(client, now);
    const errors = [];
    const results = [];

    for (const ticket of tickets) {
      try {
        const ticketResults = await processTicket(client, db, ticket, now);
        results.push(...ticketResults);
      } catch (error) {
        errors.push({ ticket_id: ticket.id, error: error.message });
        console.error(`Monitoring ticket #${ticket.id} failed:`, error.message);
      }
    }

    const summary = summarizeResults(tickets, results, errors);
    console.log('Monitoring poll complete', summary);

    return {
      success: errors.length === 0,
      error: errors.length ? `${errors.length} ticket(s) failed` : null,
      summary,
      results,
      errors
    };
  } catch (error) {
    console.error('Monitoring poll failed:', error.message);

    return { success: false, error: error.message };
  }
}
