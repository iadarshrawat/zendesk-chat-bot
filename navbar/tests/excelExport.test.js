import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fetchExportSessions, createMonitoringWorkbook, downloadMonitoringWorkbook } from "../assets/excelExport.js";

const module = { exports: {} };
vm.runInThisContext(`(function(module, exports) { ${fs.readFileSync(new URL("../assets/vendor/exceljs-4.4.0.min.js", import.meta.url), "utf8")}\n})`, {
  filename: "exceljs-4.4.0.min.js",
})(module, module.exports);
const ExcelJS = module.exports;
const filters = { from: "2026-10-01", to: "2026-10-07", search: "refund", score: "" };
const session = (ticketId, sessionNumber, overrides = {}) => ({
  ticketId, sessionNumber, externalId: `ai-monitor:v2:${ticketId}:message-${sessionNumber}`,
  updatedAt: "2026-10-06T10:00:00Z", evaluatedAt: "2026-10-06T10:00:00Z", reportDate: "2026-10-06",
  ticketSubject: "Refund request", score: "neutral", reason: "Waiting for the refund.", keyIssue: "Refund",
  sessionStartedAt: "2026-10-06T07:30:00Z", sessionLastCustomerAt: "2026-10-06T08:00:00Z",
  sessionLastMessageAt: "2026-10-06T08:01:00Z", evaluationDueAt: "2026-10-06T10:00:00Z",
  sessionMessageCount: "3", status: "evaluated", sessionFirstMessageId: `message-${sessionNumber}`,
  ticketCreatedAt: "2026-10-01T00:00:00Z", ticketRequesterId: "12345678901234567890",
  ...overrides,
});

test("export collects later pages, preserves the search, and deduplicates overlapping sessions", async () => {
  const calls = [];
  const progress = [];
  const first = Array.from({ length: 20 }, (_, index) => session(String(index + 1), 1));
  const changedFilters = { ...filters };
  const records = await fetchExportSessions({}, changedFilters, {
    fetchPage: async (_client, received, position) => {
      calls.push({ filters: { ...received }, cursor: position.cursor });
      changedFilters.from = "2025-01-01";
      return position.cursor ? { sessions: [first[0], session("21", 1)], next: null }
        : { sessions: first, next: { cursor: "page-two" } };
    },
    onProgress: state => progress.push(state),
  });
  assert.equal(records.length, 21);
  assert.deepEqual(calls.map(call => call.cursor), [null, "page-two"]);
  assert.deepEqual(calls.map(call => call.filters), [filters, filters]);
  assert.deepEqual(progress, [{ sessions: 20, pages: 1 }, { sessions: 21, pages: 2 }]);
});

test("a later API failure or a cursor cycle aborts the full export", async () => {
  await assert.rejects(fetchExportSessions({}, filters, {
    fetchPage: async (_client, _filters, position) => {
      if (position.cursor) throw new Error("SQL report unavailable");
      return { sessions: [session("101", 1)], next: { cursor: "next" } };
    },
  }), /SQL report unavailable/);
  let page = 0;
  await assert.rejects(fetchExportSessions({}, filters, {
    fetchPage: async () => ({ sessions: [], next: { cursor: ++page === 2 ? "second" : "first" } }),
  }), /pagination did not advance/);
});

test("plain Excel export keeps every session, exact identifiers, dates, counts, and literal text", async () => {
  const records = [session("101", 1), session("101", 2, { score: "satisfied", sessionMessageCount: "0" }),
    session("9007199254740993", 1, { ticketSubject: "=HYPERLINK(\"https://example.test\",\"text\")", ticketCreatedAt: "", keyIssue: "" })];
  const result = createMonitoringWorkbook(records, filters, { ExcelJS, exportedAt: new Date("2026-10-07T09:00:00Z") });
  const buffer = await result.workbook.xlsx.writeBuffer();
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(buffer);
  assert.equal(result.sessions, 3);
  assert.equal(result.fileName, "ai-ticket-monitoring_2026-10-01_to_2026-10-07.xlsx");
  assert.deepEqual(reopened.worksheets.map(sheet => sheet.name), ["Sessions"]);
  const sessions = reopened.getWorksheet("Sessions");
  assert.equal(sessions.rowCount, 4);
  assert.equal(sessions.getCell("A1").value, "Ticket ID");
  assert.equal(sessions.getCell("C1").value, "Session");
  assert.equal(sessions.getCell("A2").value, "101");
  assert.equal(sessions.getCell("A3").value, "101");
  assert.equal(sessions.getCell("C2").value, 1);
  assert.equal(sessions.getCell("C3").value, 2);
  assert.equal(sessions.getCell("D3").value, "Satisfied");
  assert.equal(sessions.getCell("A4").value, "9007199254740993");
  assert.equal(sessions.getCell("B4").type, ExcelJS.ValueType.String);
  assert.equal(sessions.getCell("B4").value, records[2].ticketSubject);
  assert.equal(sessions.getCell("E2").value.toISOString(), "2026-10-06T00:00:00.000Z");
  assert.equal(sessions.getCell("I3").value, 0);
  assert.equal(sessions.getCell("Q4").value, null);
  assert.equal(sessions.getCell("R4").value, "12345678901234567890");
  assert.equal(sessions.getCell("A1").font.bold, true);
  assert.equal(sessions.getCell("A2").font?.bold, undefined);
  assert.equal(sessions.getCell("A1").fill?.pattern, "none");
  assert.equal(sessions.getCell("A2").fill?.pattern, "none");
  assert.deepEqual(sessions.getCell("A1").border || {}, {});
  assert.equal(sessions.autoFilter, undefined);
  assert.equal((sessions.views || []).length, 0);
});

test("download produces an XLSX blob only after a valid workbook is complete", async () => {
  const downloads = [];
  await downloadMonitoringWorkbook([session("101", 1)], filters, { ExcelJS,
    saveAs: (blob, fileName) => downloads.push({ blob, fileName }) });
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.ok(downloads[0].blob.size > 1000);
  await assert.rejects(downloadMonitoringWorkbook([], filters, { ExcelJS,
    saveAs: () => assert.fail("Empty searches must not trigger a download") }), /No monitoring sessions/);
});
