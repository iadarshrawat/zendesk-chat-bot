import test from "node:test";
import assert from "node:assert/strict";
import { fetchMonitoringPage, maxRangeDate, validateDateRange } from "../assets/zendeskRecords.js";

function record(id, reportDate = "2026-10-02", score = "satisfied") {
  return {
    id,
    external_id: `ai-monitor:v2:${id}:message-1`,
    updated_at: `${reportDate}T12:00:00Z`,
    custom_object_fields: {
      ticket_id: id,
      session_number: "1",
      report_date: reportDate,
      evaluated_at: `${reportDate}T12:00:00Z`,
      monitoring_status: "evaluated",
      csat_score: score,
    },
  };
}

test("requires valid dates in order and no more than one year apart", () => {
  assert.equal(validateDateRange("2026-10-01", "2026-10-01"), null);
  assert.equal(validateDateRange("2025-10-01", "2026-10-01"), null);
  assert.match(validateDateRange("2025-10-01", "2026-10-02"), /one year/);
  assert.match(validateDateRange("2026-10-02", "2026-10-01"), /start date/);
  assert.match(validateDateRange("2026-02-30", "2026-03-01"), /valid/);
  assert.match(validateDateRange("", "2026-10-01"), /valid/);
  assert.equal(maxRangeDate("2024-02-29"), "2025-02-28");
  assert.match(validateDateRange("2024-02-29", "2025-03-01"), /one year/);
});

test("searches Zendesk directly with bounded date groups and a score filter", async () => {
  const calls = [];
  const client = {
    async request(options) {
      calls.push(options);
      return { custom_object_records: [record("5687")], meta: { has_more: false } };
    },
  };
  const result = await fetchMonitoringPage(client, {
    from: "2026-10-01", to: "2026-10-03", search: "fan", score: "satisfied",
  });

  assert.equal(result.sessions.length, 1);
  assert.equal(result.next, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "POST");
  assert.match(calls[0].url, /query=fan/);
  assert.match(calls[0].url, /page%5Bsize%5D=20/);
  const conditions = JSON.parse(calls[0].data).filter.$and;
  assert.deepEqual(conditions[0].$or.map((item) => item["custom_object_fields.report_date"].$eq), [
    "2026-10-03", "2026-10-02", "2026-10-01",
  ]);
  assert.equal(conditions[2]["custom_object_fields.csat_score"].$eq, "satisfied");
});

test("uses a cursor for the next page without retaining previous records", async () => {
  const calls = [];
  const client = {
    async request(options) {
      calls.push(options);
      return calls.length === 1
        ? { custom_object_records: [record("5687")], meta: { has_more: true, after_cursor: "next" } }
        : { custom_object_records: [record("5688")], meta: { has_more: false } };
    },
  };
  const filters = { from: "2026-10-02", to: "2026-10-02" };
  const first = await fetchMonitoringPage(client, filters);
  const second = await fetchMonitoringPage(client, filters, first.next);
  assert.deepEqual(first.sessions.map((session) => session.ticketId), ["5687"]);
  assert.deepEqual(second.sessions.map((session) => session.ticketId), ["5688"]);
  assert.match(calls[1].url, /page%5Bafter%5D=next/);
});

test("moves to the next month when an API page has no completed v2 records", async () => {
  const calls = [];
  const client = {
    async request(options) {
      calls.push(options);
      return calls.length === 1
        ? { custom_object_records: [{ ...record("5687"), external_id: "old" }], meta: { has_more: false } }
        : { custom_object_records: [record("5688", "2026-09-30")], meta: { has_more: false } };
    },
  };
  const result = await fetchMonitoringPage(client, { from: "2026-09-30", to: "2026-10-01" });
  assert.equal(result.sessions[0].ticketId, "5688");
  assert.equal(calls.length, 2);
});

test("rejects a repeated cursor instead of looping forever", async () => {
  const client = {
    async request() {
      return { custom_object_records: [], meta: { has_more: true, after_cursor: "same" } };
    },
  };
  await assert.rejects(
    fetchMonitoringPage(client, { from: "2026-10-01", to: "2026-10-01" }, { group: 0, cursor: "same" }),
    /pagination stopped/,
  );
});
