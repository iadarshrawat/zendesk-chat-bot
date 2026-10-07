import test from "node:test";
import assert from "node:assert/strict";
import { fetchMonitoringPage, maxRangeDate, validateDateRange } from "../assets/monitoringApi.js";
import { MONITORING_API } from "../assets/monitoringConfig.js";

test("requires valid dates in order and no more than one year apart", () => {
  assert.equal(validateDateRange("2026-10-01", "2026-10-01"), null);
  assert.equal(validateDateRange("2025-10-01", "2026-10-01"), null);
  assert.match(validateDateRange("2025-10-01", "2026-10-02"), /one year/);
  assert.match(validateDateRange("2026-10-02", "2026-10-01"), /start date/);
  assert.match(validateDateRange("2026-02-30", "2026-03-01"), /valid/);
  assert.equal(maxRangeDate("2024-02-29"), "2025-02-28");
});

test("navbar fetches SQL pages with the hardcoded connection without installation settings", async () => {
  const calls = [];
  const client = {
    metadata: async () => { throw new Error("Installation settings must not be read"); },
    request: async options => {
      calls.push(options);
      return { success: true, sessions: [{ session_id: "ai-monitor:v2:5687:first", ticket_id: "5687",
        session_number: 1, score: "satisfied", monitoring_status: "evaluated", report_date: "2026-10-02" }],
      pagination: { has_more: calls.length === 1, next_cursor: calls.length === 1 ? "next" : null } };
    },
  };
  const filters = { from: "2026-10-01", to: "2026-10-03", score: "satisfied", search: "fan" };
  const first = await fetchMonitoringPage(client, filters);
  assert.equal(first.sessions[0].ticketId, "5687");
  assert.deepEqual(first.next, { cursor: "next" });
  const second = await fetchMonitoringPage(client, filters, first.next);
  assert.equal(second.next, null);
  const url = new URL(calls[0].url);
  assert.equal(url.hostname, MONITORING_API.hostname);
  assert.equal(url.pathname, "/sunshine/monitoring/sessions");
  assert.equal(url.searchParams.get("limit"), "20");
  assert.match(calls[0].url, /search=fan/);
  assert.match(calls[1].url, /cursor=next/);
  assert.equal(calls[0].type, "GET");
  assert.equal(calls[0].secure, false);
  assert.equal(calls[0].cors, false);
  assert.ok(Boolean(MONITORING_API.apiKey), "A frontend report API key must be configured");
  assert.ok(calls[0].headers.Authorization === `Bearer ${MONITORING_API.apiKey}`, "Authorization must use the configured report key");
  assert.equal(calls[0].headers["ngrok-skip-browser-warning"], "1");
  assert.doesNotMatch(calls[0].url, /custom_objects/);
});

test("invalid API responses and repeated pagination cursors fail clearly", async () => {
  await assert.rejects(fetchMonitoringPage({ request: async () => ({ success: true }) },
    { from: "2026-10-01", to: "2026-10-02" }), /invalid response/);
  const client = {
    request: async () => ({ success: true, sessions: [], pagination: { has_more: true, next_cursor: "same" } }) };
  await assert.rejects(fetchMonitoringPage(client, { from: "2026-10-01", to: "2026-10-02" }, { cursor: "same" }), /did not advance/);
});
