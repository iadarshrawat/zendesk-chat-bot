import { fetchMonitoringPage, validateDateRange } from "./monitoringApi.js";

const HEADER_ROW = 1;
const MAX_SESSIONS = 1_048_576 - HEADER_ROW;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Fetch every page for a fixed search; never download a partially fetched report. */
export async function fetchExportSessions(client, filters, {
  fetchPage = fetchMonitoringPage, onProgress = () => {},
} = {}) {
  const error = validateDateRange(filters.from, filters.to);
  if (error) throw new Error(error);
  const search = { ...filters };
  const byId = new Map();
  const cursors = new Set();
  let position = { cursor: null };
  let pages = 0;
  do {
    const page = await fetchPage(client, search, position);
    for (const session of page.sessions) {
      const previous = byId.get(session.externalId);
      if (!previous || session.updatedAt > previous.updatedAt) byId.set(session.externalId, session);
    }
    if (byId.size > MAX_SESSIONS) throw new Error("This report exceeds Excel's row limit. Select a shorter date range.");
    onProgress({ sessions: byId.size, pages: ++pages });
    position = page.next;
    if (position) {
      if (!position.cursor || cursors.has(position.cursor)) throw new Error("Export pagination did not advance. Please try again.");
      cursors.add(position.cursor);
    }
  } while (position);
  return [...byId.values()].sort((a, b) =>
    (b.evaluatedAt || b.reportDate).localeCompare(a.evaluatedAt || a.reportDate)
    || b.sessionNumber - a.sessionNumber);
}

function label(value) {
  return value ? String(value).replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase()) : "";
}

function date(value) {
  if (!value) return null;
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
}

function number(value) {
  if (value == null || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

const sessionColumns = [
  { header: "Ticket ID", key: "ticketId", width: 16 },
  { header: "Subject", key: "ticketSubject", width: 42 },
  { header: "Session", key: "sessionNumber", width: 12, type: "number" },
  { header: "Satisfaction", key: "score", width: 21, type: "label" },
  { header: "Report date (UTC)", key: "reportDate", width: 19, type: "date" },
  { header: "Started (UTC)", key: "sessionStartedAt", width: 24, type: "datetime" },
  { header: "Last customer message (UTC)", key: "sessionLastCustomerAt", width: 30, type: "datetime" },
  { header: "Last message (UTC)", key: "sessionLastMessageAt", width: 24, type: "datetime" },
  { header: "Messages", key: "sessionMessageCount", width: 14, type: "number" },
  { header: "Monitoring status", key: "status", width: 22, type: "label" },
  { header: "Reason", key: "reason", width: 60 },
  { header: "Key issue", key: "keyIssue", width: 36 },
  { header: "Evaluation due (UTC)", key: "evaluationDueAt", width: 24, type: "datetime" },
  { header: "Evaluated (UTC)", key: "evaluatedAt", width: 24, type: "datetime" },
  { header: "First message ID", key: "sessionFirstMessageId", width: 30 },
  { header: "Session ID", key: "externalId", width: 48 },
  { header: "Ticket created (UTC)", key: "ticketCreatedAt", width: 24, type: "datetime" },
  { header: "Requester ID", key: "ticketRequesterId", width: 20 },
];

function addSessionsSheet(workbook, records) {
  const sheet = workbook.addWorksheet("Sessions");
  sheet.columns = sessionColumns.map(({ header, key, width }) => ({ header, key, width }));
  sheet.getRow(HEADER_ROW).font = { bold: true };
  for (const record of records) {
    const values = sessionColumns.map(column => {
      const value = record[column.key];
      if (column.type === "number") return number(value);
      if (column.type === "date" || column.type === "datetime") return date(value);
      if (column.type === "label") return label(value);
      return value == null ? "" : String(value);
    });
    const row = sheet.addRow(values);
    row.eachCell({ includeEmpty: true }, (cell, index) => {
      const column = sessionColumns[index - 1];
      if (column.type === "date") cell.numFmt = "yyyy-mm-dd";
      if (column.type === "datetime") cell.numFmt = "yyyy-mm-dd hh:mm:ss";
      if (column.type === "number") cell.numFmt = "#,##0";
      if (!column.type) cell.numFmt = "@";
    });
  }
  return sheet;
}

export function createMonitoringWorkbook(sessions, filters, {
  ExcelJS = globalThis.ExcelJS, exportedAt = new Date(),
} = {}) {
  if (typeof ExcelJS?.Workbook !== "function") throw new Error("The Excel library could not load. Reload the app and try again.");
  const error = validateDateRange(filters.from, filters.to);
  if (error) throw new Error(error);
  if (!sessions.length) throw new Error("No monitoring sessions match this search. Choose different dates or filters.");
  if (sessions.length > MAX_SESSIONS) throw new Error("This report exceeds Excel's row limit. Select a shorter date range.");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AI Ticket Monitoring";
  workbook.created = exportedAt;
  addSessionsSheet(workbook, sessions);
  return { workbook, fileName: `ai-ticket-monitoring_${filters.from}_to_${filters.to}.xlsx`, sessions: sessions.length };
}

export async function downloadMonitoringWorkbook(sessions, filters, {
  ExcelJS = globalThis.ExcelJS, saveAs = globalThis.saveAs, exportedAt = new Date(),
} = {}) {
  if (typeof saveAs !== "function") throw new Error("The download library could not load. Reload the app and try again.");
  const result = createMonitoringWorkbook(sessions, filters, { ExcelJS, exportedAt });
  const buffer = await result.workbook.xlsx.writeBuffer();
  saveAs(new Blob([buffer], { type: XLSX_MIME }), result.fileName);
  return result;
}
