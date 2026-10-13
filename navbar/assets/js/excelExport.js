// js/: Excel export. This file downloads plain session or customer-intent reports using shared workbook helpers.
import { fetchMonitoringPage, validateDateRange } from "./monitoringApi.js";
import { compareSessionsNewestFirst } from "./reportData.js";
import { formatCustomerIntent, formatLabel } from "./formatters.js";

const HEADER_ROW = 1;
const MAX_EXCEL_ROWS = 1_048_576 - HEADER_ROW;
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
    if (sessionsById.size > MAX_EXCEL_ROWS)
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
 * Convert a numeric report field to an Excel number cell value.
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
  {
    header: "Customer intent",
    key: "customerIntent",
    width: 42,
    type: "intent",
  },
  { header: "Intent product", key: "intentProduct", width: 24 },
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

const intentColumns = [
  { header: "Customer intent", key: "intent_name", width: 60, type: "intent" },
  { header: "Product", key: "product", width: 30 },
  { header: "Sessions", key: "session_count", width: 14, type: "number" },
  { header: "Share (%)", key: "percentage", width: 14, type: "decimal" },
];

/**
 * Add a plain report worksheet with readable headers and typed values.
 * @param {Object} workbook - ExcelJS workbook receiving the sheet.
 * @param {Array<Object>} records - Session or intent rows to export.
 * @param {string} sheetName - Worksheet title.
 * @param {Array<Object>} columns - Headers, record keys, widths, and value types.
 * @returns {Object} The worksheet that was added to the workbook.
 */
function addReportSheet(workbook, records, sheetName, columns) {
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = columns.map(({ header, key, width }) => ({
    header,
    key,
    width,
  }));
  sheet.getRow(HEADER_ROW).font = { bold: true };
  for (const record of records) {
    const values = columns.map((column) => {
      const value = record[column.key];
      if (column.type === "number" || column.type === "decimal")
        return toExcelNumber(value);
      if (column.type === "date" || column.type === "datetime")
        return toExcelDate(value);
      if (column.type === "label") return formatLabel(value, "") || null;
      if (column.type === "intent") return formatCustomerIntent(value);
      // Real blank cells avoid empty shared-string references appearing as numbers in some readers.
      return value == null || value === "" ? null : String(value);
    });
    const row = sheet.addRow(values);
    row.eachCell({ includeEmpty: true }, (cell, index) => {
      const column = columns[index - 1];
      if (column.type === "date") cell.numFmt = "yyyy-mm-dd";
      if (column.type === "datetime") cell.numFmt = "yyyy-mm-dd hh:mm:ss";
      if (column.type === "number") cell.numFmt = "#,##0";
      if (column.type === "decimal") cell.numFmt = "0.0";
      if (!column.type) cell.numFmt = "@";
    });
  }
  return sheet;
}

/**
 * Validate report bounds and create a plain workbook for either export view.
 * @param {Array<Object>} records - Rows for the chosen report.
 * @param {Object} filters - Applied report dates and filters.
 * @param {Object} options - Sheet name, columns, filename prefix, and empty-report message.
 * @returns {Object} Workbook and download filename; throws for missing libraries or invalid reports.
 */
function createReportWorkbook(
  records,
  filters,
  { sheetName, columns, filePrefix, emptyMessage },
) {
  const ExcelJS = globalThis.ExcelJS;
  if (typeof ExcelJS?.Workbook !== "function")
    throw new Error(
      "The Excel library could not load. Reload the app and try again.",
    );
  const error = validateDateRange(filters.from, filters.to);
  if (error) throw new Error(error);
  if (!records.length) throw new Error(emptyMessage);
  if (records.length > MAX_EXCEL_ROWS)
    throw new Error(
      "This report exceeds Excel's row limit. Select a shorter date range.",
    );
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AI Ticket Monitoring";
  workbook.created = new Date();
  addReportSheet(workbook, records, sheetName, columns);
  return {
    workbook,
    fileName: `${filePrefix}_${filters.from}_to_${filters.to}.xlsx`,
  };
}

/**
 * Create the existing session-wise report with all session details.
 * @param {Array<Object>} sessions - Completed sessions matching the applied search.
 * @param {Object} filters - Applied report dates and filters.
 * @returns {Object} Workbook, download filename, and exported session count.
 */
export function createMonitoringWorkbook(sessions, filters) {
  return {
    ...createReportWorkbook(sessions, filters, {
      sheetName: "Sessions",
      columns: sessionColumns,
      filePrefix: "ai-ticket-monitoring",
      emptyMessage:
        "No monitoring sessions match this search. Choose different dates or filters.",
    }),
    sessions: sessions.length,
  };
}

/**
 * Create one row per customer intent with its product, frequency, and share.
 * @param {Array<Object>} intents - All ranked intents or the selected intent group.
 * @param {Object} filters - Applied report dates and filters.
 * @returns {Object} Workbook, download filename, and exported intent count.
 */
export function createIntentWorkbook(intents, filters) {
  return {
    ...createReportWorkbook(intents, filters, {
      sheetName: "Customer intents",
      columns: intentColumns,
      filePrefix: "customer-intents",
      emptyMessage:
        "No customer intents match this search. Choose different dates or filters.",
    }),
    intents: intents.length,
  };
}

/**
 * Write a completed workbook as an XLSX Blob and start its browser download.
 * @param {Object} result - Created workbook, filename, and exported row count.
 * @returns {Promise<Object>} The same report metadata after starting the download.
 */
async function downloadWorkbook(result) {
  const buffer = await result.workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: XLSX_MIME });
  downloadBlob(blob, result.fileName);
  return result;
}

/**
 * Download a plain session report using the shared XLSX writer.
 * @param {Array<Object>} sessions - Completed sessions to export.
 * @param {Object} filters - Applied report dates and filters.
 * @returns {Promise<Object>} Workbook, filename, and exported session count.
 */
export async function downloadMonitoringWorkbook(sessions, filters) {
  return downloadWorkbook(createMonitoringWorkbook(sessions, filters));
}

/**
 * Download a plain customer-intent report using the shared XLSX writer.
 * @param {Array<Object>} intents - All ranked intents or the selected intent group.
 * @param {Object} filters - Applied report dates and filters.
 * @returns {Promise<Object>} Workbook, filename, and exported intent count.
 */
export async function downloadIntentWorkbook(intents, filters) {
  return downloadWorkbook(createIntentWorkbook(intents, filters));
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
