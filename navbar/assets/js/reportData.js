// js/: session data. This file converts SQL rows and calculates the displayed page totals.
const COMPLETED_STATUSES = new Set(["evaluated", "escalated"]);
export const SATISFACTION_SCORES = [
  "satisfied",
  "neutral",
  "unsatisfied",
  "escalated",
  "insufficient_data",
];

/**
 * Convert a SQL field to trimmed text while preserving exact identifier digits.
 * @returns {string} Trimmed text, or an empty string for a missing value.
 */
function text(value) {
  return value == null ? "" : String(value).trim();
}

/**
 * Count sessions for each supported satisfaction score.
 * @returns {Object} Counts keyed by satisfied, neutral, unsatisfied, escalated, and insufficient_data.
 */
function scoreCounts(sessions) {
  const counts = {};
  for (const score of SATISFACTION_SCORES) counts[score] = 0;
  for (const session of sessions) {
    if (Object.hasOwn(counts, session.score)) counts[session.score] += 1;
  }
  return counts;
}

/**
 * Compare two sessions for sorting by newest evaluation and then session number.
 * @returns {number} A negative value puts the first session before the second; zero keeps equal order.
 */
export function compareSessionsNewestFirst(first, second) {
  const firstDate = first.evaluatedAt || first.reportDate;
  const secondDate = second.evaluatedAt || second.reportDate;
  const dateOrder = secondDate.localeCompare(firstDate);
  if (dateOrder !== 0) return dateOrder;
  return second.sessionNumber - first.sessionNumber;
}

/**
 * Convert one completed two-hour SQL monitoring row to the fields used by this app.
 * @returns {Object|null} A normalized session, or null for an invalid or incomplete row.
 */
export function sessionFromRecord(record) {
  if (!text(record?.session_id).startsWith("ai-monitor:v2:")) return null;

  const ticketId = text(record.ticket_id);
  const sessionNumber = Number(record.session_number);
  if (
    !/^\d+$/.test(ticketId) ||
    !Number.isSafeInteger(sessionNumber) ||
    sessionNumber < 1 ||
    !COMPLETED_STATUSES.has(record.monitoring_status)
  ) {
    return null;
  }

  return {
    sessionId: text(record.session_id),
    updatedAt: text(record.updated_at),
    ticketId,
    ticketSubject: text(record.ticket_subject),
    ticketCreatedAt: text(record.ticket_created_at),
    ticketRequesterId: text(record.ticket_requester_id),
    reportDate: text(record.report_date),
    sessionNumber,
    sessionStartedAt: text(record.session_started_at),
    sessionLastMessageAt: text(record.session_last_message_at),
    sessionLastCustomerAt: text(record.session_last_customer_at),
    sessionFirstMessageId: text(record.session_first_message_id),
    sessionMessageCount: text(record.session_message_count),
    evaluationDueAt: text(record.evaluation_due_at),
    evaluatedAt: text(record.evaluated_at),
    score: text(record.score),
    reason: text(record.reason),
    status: text(record.monitoring_status),
    keyIssue: text(record.key_issue),
  };
}

/**
 * Normalize API rows and keep the latest copy of each unique session ID.
 * @returns {Array} Completed sessions ordered from newest to oldest.
 */
export function completedSessions(records) {
  const bySessionId = new Map();
  for (const record of records) {
    const session = sessionFromRecord(record);
    if (!session) continue;

    const key = session.sessionId;
    const previous = bySessionId.get(key);
    if (!previous || session.updatedAt > previous.updatedAt) {
      bySessionId.set(key, session);
    }
  }
  return [...bySessionId.values()].sort(compareSessionsNewestFirst);
}

/**
 * Keep each ticket's highest session number from the displayed page.
 * @returns {Array} One latest matching session per ticket.
 */
function latestTicketSessions(sessions) {
  const latestByTicket = new Map();
  for (const session of sessions) {
    const previous = latestByTicket.get(session.ticketId);
    if (
      !previous ||
      session.sessionNumber > previous.sessionNumber ||
      (session.sessionNumber === previous.sessionNumber &&
        compareSessionsNewestFirst(session, previous) < 0)
    ) {
      latestByTicket.set(session.ticketId, session);
    }
  }

  return [...latestByTicket.values()];
}

/**
 * Calculate ticket totals, session totals, score counts, and the satisfaction percentage.
 * @returns {Object} The overview values for this page; the percentage is null if no sessions are scored.
 */
export function summarizeSessions(sessions) {
  const tickets = latestTicketSessions(sessions);
  const sessionScores = scoreCounts(sessions);
  const ticketScores = scoreCounts(tickets);
  const scoredSessions =
    sessionScores.satisfied + sessionScores.neutral + sessionScores.unsatisfied;

  let estimatedSatisfactionPercent = null;
  if (scoredSessions > 0) {
    estimatedSatisfactionPercent = Math.round(
      (sessionScores.satisfied / scoredSessions) * 100,
    );
  }

  return {
    tickets: tickets.length,
    sessions: sessions.length,
    satisfiedTickets: ticketScores.satisfied,
    ticketScores,
    sessionScores,
    estimatedSatisfactionPercent,
  };
}
