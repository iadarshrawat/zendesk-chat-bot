import { createZendeskClient } from "../../config/zendesk.js";

const OBJECT_KEY = "ticket_csat_scores";
const PAGE_SIZE = 100;
const SCORES = ["satisfied", "neutral", "unsatisfied", "escalated"];
const SCORED_RESULTS = ["satisfied", "neutral", "unsatisfied"];
const COMPLETED_MONITORING_STATUSES = ["evaluated", "escalated"];

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseBooleanField(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return value === true || value === 1 || value === "1" || value === "true";
}

export function sessionFromRecord(record) {
  // Earlier five-hour sessions used v1 IDs; do not mix their session numbers
  // with the new two-hour monitoring records in this report.
  if (!record.external_id?.startsWith("ai-monitor:v2:")) {
    return null;
  }

  const fields = record.custom_object_fields || {};
  const ticketId = String(fields.ticket_id ?? "").trim();
  const sessionNumber = Number(fields.session_number);

  // The custom object may also contain operational records. Only report
  // evaluated ticket sessions, which have both parts of their identity.
  const hasValidIdentity =
    /^\d+$/.test(ticketId) &&
    Number.isSafeInteger(sessionNumber) &&
    sessionNumber >= 1;
  const isCompleted = COMPLETED_MONITORING_STATUSES.includes(fields.monitoring_status);

  if (!hasValidIdentity || !isCompleted) {
    return null;
  }

  return {
    record_id: record.id || null,
    ticket_id: ticketId,
    ticket_subject: fields.ticket_subject || null,
    score: fields.csat_score || null,
    reason: fields.reason || null,
    created_at: fields.ticket_created_at || record.created_at || null,
    report_date: fields.report_date || null,
    session_number: sessionNumber,
    session_started_at: fields.session_started_at || null,
    session_last_message_at: fields.session_last_message_at || null,
    evaluation_due_at: fields.evaluation_due_at || null,
    evaluated_at: fields.evaluated_at || null,
    monitoring_status: fields.monitoring_status || null,
    confidence: fields.confidence || null,
    human_required: parseBooleanField(fields.human_required),
    follow_up_required: parseBooleanField(fields.follow_up_required),
    key_issue: fields.key_issue || null,
    updated_at: record.updated_at || null,
  };
}

async function fetchSessionRecords(client, reportDate) {
  const records = [];
  let afterCursor;
  const seenCursors = new Set();
  const searchPath = `/custom_objects/${OBJECT_KEY}/records/search`;
  const listPath = `/custom_objects/${OBJECT_KEY}/records`;
  const filter = { "custom_object_fields.report_date": { "$eq": reportDate } };

  while (true) {
    const params = {
      "page[size]": PAGE_SIZE,
      sort: reportDate ? "-created_at" : "-updated_at",
    };
    if (afterCursor) {
      params["page[after]"] = afterCursor;
    }

    // Zendesk text fields support equality but not range comparison. For a
    // single day, search server-side. For a range, page through the object and
    // filter the actual report_date below rather than record created_at.
    const response = reportDate
      ? await client.post(searchPath, { filter }, { params })
      : await client.get(listPath, { params });
    const data = response.data || {};
    records.push(...(data.custom_object_records || data.results || []));

    if (!data.meta?.has_more) {
      break;
    }

    const nextCursor = data.meta.after_cursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error("Zendesk custom object pagination did not advance");
    }
    seenCursors.add(nextCursor);
    afterCursor = nextCursor;
  }

  return records;
}

function latestSessionsInDateRange(records, from, to) {
  const sessionsByKey = new Map();

  for (const record of records) {
    const session = sessionFromRecord(record);
    const isInDateRange =
      session &&
      isValidDate(session.report_date) &&
      session.report_date >= from &&
      session.report_date <= to;

    if (!isInDateRange) {
      continue;
    }

    const sessionKey = `${session.ticket_id}:${session.session_number}`;
    const previous = sessionsByKey.get(sessionKey);

    // An older writer created duplicate records on repeated runs. Count a
    // ticket session only once, preferring its latest saved evaluation.
    if (!previous || (session.updated_at || "") > (previous.updated_at || "")) {
      sessionsByKey.set(sessionKey, session);
    }
  }

  return [...sessionsByKey.values()].sort((a, b) =>
    (b.evaluated_at || b.report_date).localeCompare(a.evaluated_at || a.report_date));
}

export function summarizeSessions(sessions) {
  const scoreBreakdown = Object.fromEntries(SCORES.map(score => [score, 0]));
  let skipped = 0;

  for (const session of sessions) {
    if (Object.hasOwn(scoreBreakdown, session.score)) {
      scoreBreakdown[session.score]++;
    } else {
      skipped++;
    }

  }

  const scoredSessions =
    scoreBreakdown.satisfied +
    scoreBreakdown.neutral +
    scoreBreakdown.unsatisfied;
  const scoredTickets = new Set(
    sessions
      .filter(session => SCORED_RESULTS.includes(session.score))
      .map(session => session.ticket_id),
  ).size;
  const distinctTickets = new Set(sessions.map(session => session.ticket_id)).size;
  const csatPercent = scoredSessions
    ? Math.round((scoreBreakdown.satisfied / scoredSessions) * 100)
    : null;

  return {
    total_tickets: distinctTickets,
    scored_tickets: scoredTickets,
    scored_sessions: scoredSessions,
    skipped_insufficient: skipped,
    csat_percent: csatPercent,
    score_breakdown: scoreBreakdown,
    total_sessions: sessions.length,
    distinct_tickets: distinctTickets,
  };
}

/** GET /sunshine/report?from=YYYY-MM-DD&to=YYYY-MM-DD */
export async function generateReport(req, res) {
  const today = new Date().toISOString().slice(0, 10);
  const from = req.query.from || today;
  const to = req.query.to || today;

  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({
      success: false,
      error: "Invalid date format. Use YYYY-MM-DD for 'from' and 'to' params.",
    });
  }
  if (from > to) {
    return res.status(400).json({
      success: false,
      error: "'from' date cannot be after 'to' date.",
    });
  }

  try {
    const client = await createZendeskClient();
    const records = await fetchSessionRecords(client, from === to ? from : null);
    const tickets = latestSessionsInDateRange(records, from, to);

    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      date_range: { from, to },
      summary: summarizeSessions(tickets),
      tickets: tickets.map(({ updated_at, ...session }) => session),
    });
  } catch (error) {
    console.error("generateReport error:", error);
    return res.status(502).json({
      success: false,
      generated_at: new Date().toISOString(),
      error: error.message,
    });
  }
}
