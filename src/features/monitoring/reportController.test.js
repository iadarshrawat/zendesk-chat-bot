import test from "node:test";
import assert from "node:assert/strict";
import { sessionFromRecord, summarizeSessions } from "./reportController.js";

test("report ignores legacy resolution fields and keeps satisfaction", () => {
  const session = sessionFromRecord({
    id: "record-1",
    external_id: "ai-monitor:v2:5687:message-1",
    custom_object_fields: {
      ticket_id: "5687",
      session_number: "1",
      monitoring_status: "evaluated",
      csat_score: "satisfied",
      resolution_status: "resolved",
      returned_after_resolution: "true",
    },
  });

  assert.equal(session.score, "satisfied");
  assert.equal(Object.hasOwn(session, "resolution_status"), false);
  assert.equal(Object.hasOwn(session, "returned_after_resolution"), false);

  const summary = summarizeSessions([session]);
  assert.equal(summary.score_breakdown.satisfied, 1);
  assert.equal(summary.csat_percent, 100);
  assert.equal(Object.hasOwn(summary, "resolution_breakdown"), false);
});
