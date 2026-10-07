import test from "node:test";
import assert from "node:assert/strict";
import {
  completedSessions,
  filterSessions,
  sessionFromRecord,
  summarizeSessions,
} from "../assets/reportData.js";

function record(ticketId, sessionNumber, score, overrides = {}) {
  return {
    record_id: `ai-monitor:v2:${ticketId}:message-${sessionNumber}`,
    session_id: `ai-monitor:v2:${ticketId}:message-${sessionNumber}`,
    updated_at: `2026-10-0${sessionNumber}T12:00:00Z`,
    ticket_id: String(ticketId), ticket_subject: `Ticket ${ticketId}`,
    session_number: sessionNumber, report_date: `2026-10-0${sessionNumber}`,
    session_started_at: `2026-10-0${sessionNumber}T09:00:00Z`,
    evaluated_at: `2026-10-0${sessionNumber}T12:00:00Z`,
    score, monitoring_status: "evaluated", follow_up_required: true, ...overrides,
  };
}

test("shows only completed v2 monitoring records", () => {
  assert.equal(sessionFromRecord(record(5687, 1, "satisfied")).ticketId, "5687");
  assert.equal(sessionFromRecord({ ...record(5687, 1, "satisfied"), session_id: "old-id" }), null);
  assert.equal(sessionFromRecord(record(5687, 1, "satisfied", { monitoring_status: "pending" })), null);
  assert.equal(sessionFromRecord(record("abc", 1, "satisfied")), null);
});

test("ignores fields that are no longer displayed in the navbar", () => {
  const session = sessionFromRecord(record(5687, 1, "satisfied", {
    resolution_status: "resolved",
    returned_after_resolution: "true",
    human_required: "true",
    follow_up_required: "true",
    confidence: "low",
  }));
  assert.equal(Object.hasOwn(session, "resolution"), false);
  assert.equal(Object.hasOwn(session, "returnedAfterResolution"), false);
  assert.equal(Object.hasOwn(session, "humanRequired"), false);
  assert.equal(Object.hasOwn(session, "followUpRequired"), false);
  assert.equal(Object.hasOwn(session, "confidence"), false);
});

test("deduplicates a ticket session but preserves later sessions on the same ticket", () => {
  const old = record(5687, 1, "neutral");
  const replacement = { ...record(5687, 1, "satisfied"), updated_at: "2026-10-05T12:00:00Z" };
  const sessions = completedSessions([old, replacement, record(5687, 2, "unsatisfied")]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions.find((session) => session.sessionNumber === 1).score, "satisfied");
});

test("ticket outcomes use the latest session; session breakdown includes every session", () => {
  const sessions = completedSessions([
    record(5687, 1, "satisfied"),
    record(5687, 2, "unsatisfied"),
    record(5688, 1, "satisfied"),
  ]);
  const summary = summarizeSessions(sessions);
  assert.equal(summary.tickets, 2);
  assert.equal(summary.sessions, 3);
  assert.equal(summary.satisfiedTickets, 1);
  assert.deepEqual([summary.sessionScores.satisfied, summary.sessionScores.unsatisfied], [2, 1]);
  assert.equal(summary.estimatedSatisfactionPercent, 67);
  assert.equal(Object.hasOwn(summary, "resolutions"), false);
  assert.equal(Object.hasOwn(summary, "followUpRequired"), false);
  assert.equal(Object.hasOwn(summary, "humanRequired"), false);
  assert.equal(Object.hasOwn(summary, "confidence"), false);
});

test("filters by report date, ticket text and satisfaction score", () => {
  const sessions = completedSessions([
    record(5687, 1, "satisfied"),
    record(5687, 2, "unsatisfied"),
    record(5688, 1, "neutral"),
  ]);
  assert.equal(filterSessions(sessions, { from: "2026-10-02" }).length, 1);
  assert.equal(filterSessions(sessions, { search: "5688" }).length, 1);
  assert.equal(filterSessions(sessions, { score: "satisfied" }).length, 1);
});
