import { MONITORING_SCORES, monitoringIssueType } from './index.js';

function iso(value) {
  return value instanceof Date ? value.toISOString() : value || null;
}

/**
 * Serialize SQL timestamps and preserve the existing session identities and report aliases.
 * @param {Object} row - SQL monitoring session row.
 * @returns {Object} The session object returned by the monitoring API.
 */
export function sessionFromRow(row) {
  const result = {
    ...row,
    record_id: row.session_id,
    external_id: row.session_id
  };
  result.record_name = `Ticket #${row.ticket_id} | session ${row.session_number}`;
  for (const field of [
    'ticket_created_at',
    'session_started_at',
    'session_last_customer_at',
    'session_last_message_at',
    'evaluation_due_at',
    'evaluated_at',
    'updated_at'
  ]) {
    result[field] = iso(row[field]);
  }
  result.created_at = result.ticket_created_at;
  result.report_date = iso(row.report_date)?.slice(0, 10) || null;
  result.issue_type = monitoringIssueType(row.issue_type);

  return result;
}

/**
 * Calculate the existing page-scoped ticket, session, and satisfaction counts.
 * @param {Array<Object>} sessions - Detected or reported customer sessions.
 * @returns {Object} The monitoring summary for the supplied page only.
 */
export function summarizeSessions(sessions) {
  const breakdown = Object.fromEntries(MONITORING_SCORES.map(score => [score, 0]));
  for (const session of sessions) {
    if (Object.hasOwn(breakdown, session.score)) {
      breakdown[session.score] += 1;
    }
  }
  const scored = breakdown.satisfied + breakdown.neutral + breakdown.unsatisfied;
  const tickets = new Set(sessions.map(session => session.ticket_id)).size;

  return {
    total_tickets: tickets,
    distinct_tickets: tickets,
    total_sessions: sessions.length,
    scored_tickets: new Set(
      sessions.filter(session => ['satisfied', 'neutral', 'unsatisfied'].includes(session.score)).map(session => session.ticket_id)
    ).size,
    scored_sessions: scored,
    skipped_insufficient: breakdown.insufficient_data,
    csat_percent: scored ? Math.round((breakdown.satisfied / scored) * 100) : null,
    score_breakdown: breakdown,
    scope: 'page'
  };
}

/**
 * Rank SQL issue counts and calculate each category's share of matched sessions.
 * @param {Array<Object>} rows - SQL categories and counts, including legacy nulls.
 * @returns {Object} issues in descending frequency and totalSessions.
 */
export function rankIssueCounts(rows) {
  const issues = rows.map(row => ({
    issue_type: monitoringIssueType(row.issue_type),
    session_count: Number(row.session_count)
  }));
  const totalSessions = issues.reduce((total, issue) => total + issue.session_count, 0);
  for (const issue of issues) {
    issue.percentage = totalSessions ? Math.round((issue.session_count / totalSessions) * 1000) / 10 : 0;
  }
  issues.sort((first, second) => second.session_count - first.session_count || first.issue_type.localeCompare(second.issue_type));

  return { issues, totalSessions };
}
