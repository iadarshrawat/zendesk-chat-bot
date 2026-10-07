import test from "node:test";
import assert from "node:assert/strict";
import { createReportController, reportFilters, sessionFromRow, summarizeSessions } from "./reportController.js";
import { monitoringPage } from "./monitoringRepository.js";

function row(id = "message-1") {
  return { session_id: `ai-monitor:v2:5687:${id}`, ticket_id: "5687", session_number: 1,
    report_date: new Date("2026-10-02T00:00:00Z"), updated_at: new Date("2026-10-02T12:00:00Z"),
    evaluated_at: new Date("2026-10-02T12:00:00Z"), ticket_subject: "Fan support", score: "satisfied" };
}

function response() {
  return { statusCode: 200, status(value) { this.statusCode = value; return this; },
    set() { return this; }, json(value) { this.body = value; return this; } };
}

test("report serializes SQL timestamps and calculates page-scoped satisfaction", () => {
  const session = sessionFromRow(row());
  assert.equal(session.report_date, "2026-10-02");
  assert.equal(session.evaluated_at, "2026-10-02T12:00:00.000Z");
  assert.equal(session.record_id, session.session_id);
  const summary = summarizeSessions([session]);
  assert.equal(summary.csat_percent, 100);
  assert.equal(summary.scope, "page");
  assert.equal(Object.hasOwn(summary, "resolution_breakdown"), false);
});

test("date, score, search, page size and cursor are validated before SQL", () => {
  const query = { from: "2026-10-01", to: "2026-10-02" };
  for (const invalid of [
    { from: "2026-02-30" }, { from: "2026-10-03" }, { from: "2024-10-01" },
    { score: "bad" }, { search: "x".repeat(201) }, { limit: "101" },
    { limit: "0" }, { limit: "1; DROP TABLE sessions" }, { cursor: "not-json" },
  ]) assert.throws(() => reportFilters({ ...query, ...invalid }), TypeError);
  assert.equal(reportFilters(query).limit, 20);
  assert.equal(reportFilters({ from: "2024-02-29", to: "2025-02-28" }).limit, 20);
  assert.throws(() => reportFilters({ from: "2024-02-29", to: "2025-03-01" }));
});

test("SQL report generates a next cursor tied to the same search filters", async () => {
  const query = { from: "2026-10-01", to: "2026-10-03", search: "fan" };
  const calls = [];
  const controller = createReportController({ db: {}, readPage: async (_db, filters) => {
    calls.push(filters); return { rows: [row()], hasMore: !filters.after };
  } });
  const first = response();
  await controller({ query }, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.sessions.length, 1);
  assert.equal(first.body.pagination.has_more, true);
  const second = response();
  await controller({ query: { ...query, cursor: first.body.pagination.next_cursor } }, second);
  assert.equal(second.body.pagination.next_cursor, null);
  assert.equal(calls[1].after.session_id, "ai-monitor:v2:5687:message-1");
  const changedSearch = response();
  await controller({ query: { ...query, search: "heater", cursor: first.body.pagination.next_cursor } }, changedSearch);
  assert.equal(changedSearch.statusCode, 400);
  assert.equal(calls.length, 2);
});

test("SQL filtering uses bounded typed parameters and treats LIKE characters literally", async () => {
  let query;
  const values = {};
  const db = { request: () => ({ input(name, _type, value) { values[name] = value; return this; },
    cancel() {}, async query(value) { query = value; return { recordset: [row("one"), row("two")] }; } }) };
  const result = await monitoringPage(db, { from: "2026-10-01", to: "2026-10-03", score: "satisfied",
    search: "50%_[x]~'; DROP TABLE users;--", limit: 1, after: null });
  assert.equal(result.rows.length, 1);
  assert.equal(result.hasMore, true);
  assert.equal(values.rowLimit, 2);
  assert.match(values.pattern, /50~%~_~\[x\]~~/);
  assert.doesNotMatch(query, /DROP TABLE users/);
  assert.match(query, /INNER JOIN .*bot_monitor_sessions/);
  assert.match(query, /ORDER BY e.report_date DESC, e.updated_at DESC, e.session_id DESC/);
});

test("database failure returns a generic 503 without SQL details", async () => {
  const controller = createReportController({ db: {}, readPage: async () => { throw new Error("private SQL details"); } });
  const res = response();
  await controller({ query: { from: "2026-10-01", to: "2026-10-02" } }, res);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /private SQL/);
});
