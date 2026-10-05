const COMPLETED_STATUSES = new Set(["evaluated", "escalated"]);
const SCORES = ["satisfied", "neutral", "unsatisfied", "escalated", "insufficient_data"];

function text(value) {
  return value == null ? "" : String(value).trim();
}

function scoreCounts(sessions) {
  const counts = Object.fromEntries(SCORES.map((score) => [score, 0]));
  for (const session of sessions) {
    if (Object.hasOwn(counts, session.score)) counts[session.score] += 1;
  }
  return counts;
}

function newestFirst(a, b) {
  return (b.evaluatedAt || b.reportDate).localeCompare(a.evaluatedAt || a.reportDate)
    || b.sessionNumber - a.sessionNumber;
}

/** Keep only completed v2 AI monitoring records, not unrelated custom-object data. */
export function sessionFromRecord(record) {
  if (!text(record?.external_id).startsWith("ai-monitor:v2:")) return null;

  const fields = record.custom_object_fields || {};
  const ticketId = text(fields.ticket_id);
  const sessionNumber = Number(fields.session_number);
  if (!/^\d+$/.test(ticketId)
    || !Number.isSafeInteger(sessionNumber)
    || sessionNumber < 1
    || !COMPLETED_STATUSES.has(fields.monitoring_status)) {
    return null;
  }

  return {
    recordId: text(record.id),
    recordName: text(record.name),
    externalId: text(record.external_id),
    updatedAt: text(record.updated_at),
    ticketId,
    ticketSubject: text(fields.ticket_subject),
    ticketCreatedAt: text(fields.ticket_created_at || record.created_at),
    ticketRequesterId: text(fields.ticket_requester_id),
    reportDate: text(fields.report_date),
    sessionNumber,
    sessionStartedAt: text(fields.session_started_at),
    sessionLastMessageAt: text(fields.session_last_message_at),
    sessionLastCustomerAt: text(fields.session_last_customer_at),
    sessionFirstMessageId: text(fields.session_first_message_id),
    sessionMessageCount: text(fields.session_message_count),
    evaluationDueAt: text(fields.evaluation_due_at),
    evaluatedAt: text(fields.evaluated_at),
    score: text(fields.csat_score),
    reason: text(fields.reason),
    status: text(fields.monitoring_status),
    keyIssue: text(fields.key_issue),
  };
}

/** An older writer could leave duplicate custom-object records for a session. */
export function completedSessions(records) {
  const byTicketSession = new Map();
  for (const record of records) {
    const session = sessionFromRecord(record);
    if (!session) continue;

    const key = `${session.ticketId}:${session.sessionNumber}`;
    const previous = byTicketSession.get(key);
    if (!previous || session.updatedAt > previous.updatedAt) {
      byTicketSession.set(key, session);
    }
  }
  return [...byTicketSession.values()].sort(newestFirst);
}

export function filterSessions(sessions, filters = {}) {
  const search = text(filters.search).toLowerCase();
  return sessions.filter((session) => {
    if (filters.from && session.reportDate < filters.from) return false;
    if (filters.to && session.reportDate > filters.to) return false;
    if (filters.score && session.score !== filters.score) return false;
    if (!search) return true;
    return [session.ticketId, session.ticketSubject, session.keyIssue, session.reason]
      .some((value) => value.toLowerCase().includes(search));
  });
}

/** Ticket outcomes use each ticket's latest session; session totals use every session. */
export function summarizeSessions(sessions) {
  const latestByTicket = new Map();
  for (const session of sessions) {
    const previous = latestByTicket.get(session.ticketId);
    if (!previous || session.sessionNumber > previous.sessionNumber
      || (session.sessionNumber === previous.sessionNumber && newestFirst(session, previous) < 0)) {
      latestByTicket.set(session.ticketId, session);
    }
  }

  const sessionScores = scoreCounts(sessions);
  const ticketScores = scoreCounts(latestByTicket.values());
  const scoredSessions = sessionScores.satisfied + sessionScores.neutral + sessionScores.unsatisfied;

  return {
    tickets: latestByTicket.size,
    sessions: sessions.length,
    satisfiedTickets: ticketScores.satisfied,
    ticketScores,
    sessionScores,
    estimatedSatisfactionPercent: scoredSessions
      ? Math.round((sessionScores.satisfied / scoredSessions) * 100)
      : null,
  };
}
