import { createHash } from "node:crypto";
import { getPool } from "../../config/sql.js";
import { safeErrorMetadata } from "../../shared/timingLogger.js";
import { MONITORING_SCORES, validReportDate } from "./monitoringData.js";
import { monitoringPage } from "./monitoringRepository.js";

function iso(value) {
  return value instanceof Date ? value.toISOString() : value || null;
}

export function sessionFromRow(row) {
  const result = { ...row, record_id: row.session_id, external_id: row.session_id };
  result.record_name = `Ticket #${row.ticket_id} | session ${row.session_number}`;
  for (const field of ["ticket_created_at", "session_started_at", "session_last_customer_at",
    "session_last_message_at", "evaluation_due_at", "evaluated_at", "updated_at"]) {
    result[field] = iso(row[field]);
  }
  result.created_at = result.ticket_created_at;
  result.report_date = iso(row.report_date)?.slice(0, 10) || null;
  return result;
}

export function summarizeSessions(sessions) {
  const breakdown = Object.fromEntries(MONITORING_SCORES.map(score => [score, 0]));
  for (const session of sessions) if (Object.hasOwn(breakdown, session.score)) breakdown[session.score] += 1;
  const scored = breakdown.satisfied + breakdown.neutral + breakdown.unsatisfied;
  const tickets = new Set(sessions.map(session => session.ticket_id)).size;
  return {
    total_tickets: tickets, distinct_tickets: tickets, total_sessions: sessions.length,
    scored_tickets: new Set(sessions.filter(session => ["satisfied", "neutral", "unsatisfied"].includes(session.score))
      .map(session => session.ticket_id)).size,
    scored_sessions: scored, skipped_insufficient: breakdown.insufficient_data,
    csat_percent: scored ? Math.round(breakdown.satisfied / scored * 100) : null,
    score_breakdown: breakdown,
    scope: "page",
  };
}

function rangeLimit(from) {
  const date = new Date(`${from}T00:00:00Z`);
  const year = date.getUTCFullYear() + 1;
  const month = date.getUTCMonth();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate())))
    .toISOString().slice(0, 10);
}

function filterHash(filters) {
  return createHash("sha256").update(JSON.stringify(filters)).digest("hex").slice(0, 32);
}

export function reportFilters(query, today = new Date().toISOString().slice(0, 10)) {
  const filters = { from: query.from ?? today, to: query.to ?? today,
    score: query.score ?? "", search: query.search ?? "", limit: query.limit ?? "20" };
  if (!validReportDate(filters.from) || !validReportDate(filters.to)
    || filters.from > filters.to || filters.to > rangeLimit(filters.from)) {
    throw new TypeError("Select valid report dates in order, no more than one year apart.");
  }
  if (typeof filters.score !== "string" || (filters.score && !MONITORING_SCORES.includes(filters.score))) {
    throw new TypeError("Invalid satisfaction score.");
  }
  if (typeof filters.search !== "string" || filters.search.length > 200) {
    throw new TypeError("Search text must be no more than 200 characters.");
  }
  filters.search = filters.search.trim();
  if (typeof filters.limit !== "string" || !/^\d+$/.test(filters.limit)
    || Number(filters.limit) < 1 || Number(filters.limit) > 100) {
    throw new TypeError("Page limit must be between 1 and 100.");
  }
  filters.limit = Number(filters.limit);
  const fingerprint = filterHash(filters);
  let after = null;
  if (query.cursor != null) {
    if (typeof query.cursor !== "string" || query.cursor.length > 1500 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) {
      throw new TypeError("Invalid page cursor.");
    }
    try {
      after = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (after.version !== 1 || after.filters !== fingerprint || !validReportDate(after.report_date)
        || after.report_date < filters.from || after.report_date > filters.to
        || typeof after.session_id !== "string" || after.session_id.length > 255
        || !/^ai-monitor:v2:\d+:.+$/.test(after.session_id)
        || typeof after.updated_at !== "string" || !Number.isFinite(Date.parse(after.updated_at))) {
        throw new Error("Invalid cursor");
      }
    } catch {
      throw new TypeError("Page cursor is invalid or belongs to a different search.");
    }
  }
  return { ...filters, after, fingerprint };
}

/** GET /sunshine/report: authenticated SQL-only, server-filtered, cursor-paginated. */
export function createReportController({ db = getPool, readPage = monitoringPage } = {}) {
  return async function generateReport(req, res) {
    let filters;
    try { filters = reportFilters(req.query); }
    catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    try {
      const page = await readPage(typeof db === "function" ? db() : db, filters);
      const sessions = page.rows.map(sessionFromRow);
      const last = sessions.at(-1);
      const cursor = page.hasMore && last ? Buffer.from(JSON.stringify({
        version: 1, filters: filters.fingerprint,
        report_date: last.report_date, updated_at: last.updated_at, session_id: last.session_id,
      })).toString("base64url") : null;
      res.set("Cache-Control", "no-store");
      return res.status(200).json({
        success: true, generated_at: new Date().toISOString(), date_range: { from: filters.from, to: filters.to },
        summary: summarizeSessions(sessions), sessions, tickets: sessions,
        pagination: { limit: filters.limit, has_more: page.hasMore, next_cursor: cursor },
      });
    } catch (error) {
      console.error("SQL monitoring report unavailable", safeErrorMetadata(error));
      return res.status(503).json({ success: false, error: "Monitoring data is temporarily unavailable." });
    }
  };
}

export const generateReport = createReportController();
