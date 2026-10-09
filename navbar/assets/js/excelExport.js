// js/: Excel export. This file fetches all matching sessions and downloads one plain Sessions worksheet.
import { fetchMonitoringPage, validateDateRange } from "./monitoringApi.js";
import { compareSessionsNewestFirst } from "./reportData.js";
import { formatIssueType, formatLabel } from "./formatters.js";

const HEADER_ROW = 1;
const MAX_SESSIONS = 1_048_576 - HEADER_ROW;
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Fetch every result page for the applied filters and report progress when a handler is supplied.
 * @returns {Promise<Array>} Unique completed sessions sorted newest first. Throws before downloading if any page fails.
 */
export async function fetchExportSessions(client, filters, onProgress) {
  const error = validateDateRange(filters.from, filters.to);
  if (error) throw new Error(error);
  const search = { ...filters };
  const sessionsById = new Map();
  const visitedCursors = new Set();
  let position = { cursor: null };
  let pages = 0;
  while (position) {
    const page = await fetchMonitoringPage(client, search, position);
    for (const session of page.sessions) {
      const previous = sessionsById.get(session.sessionId);
      if (!previous || session.updatedAt > previous.updatedAt)
        sessionsById.set(session.sessionId, session);
    }
    if (sessionsById.size > MAX_SESSIONS)
      throw new Error(
        "This report exceeds Excel's row limit. Select a shorter date range.",
      );
    pages += 1;
    if (onProgress) onProgress({ sessions: sessionsById.size, pages });
    position = page.next;
    if (position) {
      if (!position.cursor || visitedCursors.has(position.cursor))
        throw new Error("Export pagination did not advance. Please try again.");
      visitedCursors.add(position.cursor);
    }
  }
  return [...sessionsById.values()].sort(compareSessionsNewestFirst);
}

/**
 * Convert a report date or UTC timestamp to an Excel date cell value.
 * @returns {Date|null} A valid Date, or null for a missing or invalid date.
 */
function toExcelDate(value) {
  if (!value) return null;
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
}

/**
 * Convert a session number or message count to an Excel number cell value.
 * @returns {number|null} A finite number, or null for a missing or invalid value.
 */
function toExcelNumber(value) {
  if (value == null || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

const sessionColumns = [
  { header: "Ticket ID", key: "ticketId", width: 16 },
  { header: "Subject", key: "ticketSubject", width: 42 },
  { header: "Session", key: "sessionNumber", width: 12, type: "number" },
  { header: "Satisfaction", key: "score", width: 21, type: "label" },
  { header: "Issue type", key: "issueType", width: 24, type: "issue" },
  { header: "Report date (UTC)", key: "reportDate", width: 19, type: "date" },
  {
    header: "Started (UTC)",
    key: "sessionStartedAt",
    width: 24,
    type: "datetime",
  },
  {
    header: "Last customer message (UTC)",
    key: "sessionLastCustomerAt",
    width: 30,
    type: "datetime",
  },
  {
    header: "Last message (UTC)",
    key: "sessionLastMessageAt",
    width: 24,
    type: "datetime",
  },
  { header: "Messages", key: "sessionMessageCount", width: 14, type: "number" },
  { header: "Monitoring status", key: "status", width: 22, type: "label" },
  { header: "Reason", key: "reason", width: 60 },
  { header: "Key issue", key: "keyIssue", width: 36 },
  {
    header: "Evaluation due (UTC)",
    key: "evaluationDueAt",
    width: 24,
    type: "datetime",
  },
  {
    header: "Evaluated (UTC)",
    key: "evaluatedAt",
    width: 24,
    type: "datetime",
  },
  { header: "First message ID", key: "sessionFirstMessageId", width: 30 },
  { header: "Session ID", key: "sessionId", width: 48 },
  {
    header: "Ticket created (UTC)",
    key: "ticketCreatedAt",
    width: 24,
    type: "datetime",
  },
  { header: "Requester ID", key: "ticketRequesterId", width: 20 },
];

/**
 * Add a plain Sessions worksheet with readable headers, typed dates, and exact text IDs.
 * @returns {Object} The worksheet that was added to the workbook.
 */
function addSessionsSheet(workbook, records) {
  const sheet = workbook.addWorksheet("Sessions");
  sheet.columns = sessionColumns.map(({ header, key, width }) => ({
    header,
    key,
    width,
  }));
  sheet.getRow(HEADER_ROW).font = { bold: true };
  for (const record of records) {
    const values = sessionColumns.map((column) => {
      const value = record[column.key];
      if (column.type === "number") return toExcelNumber(value);
      if (column.type === "date" || column.type === "datetime")
        return toExcelDate(value);
      if (column.type === "label") return formatLabel(value, "");
      if (column.type === "issue") return formatIssueType(value);
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

/**
 * Create a plain session-wise workbook after checking the date range and Excel row limit.
 * @returns {Object} The workbook, download filename, and number of exported sessions. Throws for empty or invalid reports.
 */
export function createMonitoringWorkbook(sessions, filters) {
  const ExcelJS = globalThis.ExcelJS;
  if (typeof ExcelJS?.Workbook !== "function")
    throw new Error(
      "The Excel library could not load. Reload the app and try again.",
    );
  const error = validateDateRange(filters.from, filters.to);
  if (error) throw new Error(error);
  if (!sessions.length)
    throw new Error(
      "No monitoring sessions match this search. Choose different dates or filters.",
    );
  if (sessions.length > MAX_SESSIONS)
    throw new Error(
      "This report exceeds Excel's row limit. Select a shorter date range.",
    );
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AI Ticket Monitoring";
  workbook.created = new Date();
  addSessionsSheet(workbook, sessions);
  return {
    workbook,
    fileName: `ai-ticket-monitoring_${filters.from}_to_${filters.to}.xlsx`,
    sessions: sessions.length,
  };
}

/**
 * Write the completed workbook as an XLSX Blob and start its browser download.
 * @returns {Promise<Object>} The workbook, filename, and session count after the file is ready to download.
 */
export async function downloadMonitoringWorkbook(sessions, filters) {
  const result = createMonitoringWorkbook(sessions, filters);
  const buffer = await result.workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: XLSX_MIME });
  downloadBlob(blob, result.fileName);
  return result;
}

/**
 * Start a browser download for a generated Excel Blob and clean up the temporary link.
 * @returns {void} Starts the download and releases its object URL after 30 seconds.
 */
function downloadBlob(blob, fileName) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName;
  link.hidden = true;

  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // Give the browser time to read the file before releasing the URL.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
}
