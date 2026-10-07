import { completedSessions } from "./reportData.js";
import { MONITORING_API } from "./monitoringConfig.js";

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

export function validateDateRange(from, to) {
  const start = parseDate(from);
  const end = parseDate(to);
  if (!start || !end) return "Select a valid start and end report date.";
  if (start > end) return "The start date must be on or before the end date.";
  if (to > maxRangeDate(from)) return "Select a date range of no more than one year.";
  return null;
}

export function maxRangeDate(from) {
  const start = parseDate(from);
  if (!start) return "";
  const year = start.getUTCFullYear() + 1;
  const month = start.getUTCMonth();
  const day = Math.min(start.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

/** Temporary hardcoded connection; use the Zendesk proxy for local previews too. */
export async function fetchMonitoringPage(client, filters, position = { cursor: null }) {
  const error = validateDateRange(filters.from, filters.to);
  if (error) throw new Error(error);
  const params = new URLSearchParams({ from: filters.from, to: filters.to, limit: String(MONITORING_API.pageSize) });
  if (filters.search?.trim()) params.set("search", filters.search.trim());
  if (filters.score) params.set("score", filters.score);
  if (position?.cursor) params.set("cursor", position.cursor);
  const response = await client.request({
    url: `https://${MONITORING_API.hostname}/sunshine/monitoring/sessions?${params}`,
    type: "GET", dataType: "json", cache: false, autoRetry: true,
    headers: {
      Authorization: `Bearer ${MONITORING_API.apiKey}`,
      "ngrok-skip-browser-warning": "1",
    },
    secure: false, cors: false,
  });
  if (response.success !== true || !Array.isArray(response.sessions)) {
    throw new Error("The monitoring API returned an invalid response.");
  }
  const cursor = response.pagination?.next_cursor;
  if (response.pagination?.has_more && (!cursor || cursor === position?.cursor)) {
    throw new Error("Monitoring report pagination did not advance.");
  }
  return { sessions: completedSessions(response.sessions),
    next: response.pagination?.has_more ? { cursor } : null };
}
