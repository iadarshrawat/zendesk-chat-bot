// js/: API access. This file validates report dates and fetches SQL sessions through the Zendesk proxy.
import { completedSessions } from "./reportData.js";
import { MONITORING_API } from "./monitoringConfig.js";

/**
 * Read an exact YYYY-MM-DD date and reject invalid calendar dates.
 * @returns {Date|null} The date at UTC midnight, or null if the input is invalid.
 */
function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

/**
 * Check that report dates are valid, in order, and no more than one calendar year apart.
 * @returns {string|null} An error message, or null when the range is valid.
 */
export function validateDateRange(from, to) {
  const start = parseDate(from);
  const end = parseDate(to);
  if (!start || !end) return "Select a valid start and end report date.";
  if (start > end) return "The start date must be on or before the end date.";
  if (to > maxRangeDate(from))
    return "Select a date range of no more than one year.";
  return null;
}

/**
 * Calculate the latest allowed end date, including the February 29 leap-year case.
 * @returns {string} The maximum YYYY-MM-DD end date, or an empty string for an invalid start date.
 */
export function maxRangeDate(from) {
  const start = parseDate(from);
  if (!start) return "";
  const year = start.getUTCFullYear() + 1;
  const month = start.getUTCMonth();
  const day = Math.min(
    start.getUTCDate(),
    new Date(Date.UTC(year, month + 1, 0)).getUTCDate(),
  );
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

/**
 * Convert common API failures to a message the app can show to an agent.
 * @returns {string} A readable connection, authorization, or search error message.
 */
export function monitoringApiErrorMessage(error) {
  const status = Number(error?.status || error?.responseJSON?.status);
  if (status === 401 || status === 403)
    return "Report access was denied. Check that the frontend API key matches the backend REPORT_API_KEY.";
  if (status === 404)
    return "The monitoring API endpoint was not found. Check the frontend backend hostname.";
  if (status === 400)
    return "The monitoring API rejected this search. Check the dates and search text.";
  return (
    error?.message ||
    "Could not load monitoring data. Check the API configuration and try again."
  );
}

/**
 * Fetch one page of completed SQL sessions using the configured backend and Zendesk proxy.
 * @returns {Promise<Object>} Normalized sessions and the next cursor, or null when there is no next page. Throws if the request fails.
 */
export async function fetchMonitoringPage(
  client,
  filters,
  position = { cursor: null },
) {
  const error = validateDateRange(filters.from, filters.to);
  if (error) throw new Error(error);
  const params = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    limit: String(MONITORING_API.pageSize),
  });
  if (filters.search?.trim()) params.set("search", filters.search.trim());
  if (filters.score) params.set("score", filters.score);
  if (position?.cursor) params.set("cursor", position.cursor);
  const response = await client.request({
    url: `https://${MONITORING_API.hostname}/sunshine/monitoring/sessions?${params}`,
    type: "GET",
    dataType: "json",
    cache: false,
    autoRetry: true,
    headers: {
      Authorization: `Bearer ${MONITORING_API.apiKey}`,
      "ngrok-skip-browser-warning": "1",
    },
    secure: false,
    cors: false,
  });
  if (response?.success !== true || !Array.isArray(response.sessions)) {
    throw new Error("The monitoring API returned an invalid response.");
  }
  const cursor = response.pagination?.next_cursor;
  if (
    response.pagination?.has_more &&
    (!cursor || cursor === position?.cursor)
  ) {
    throw new Error("Monitoring report pagination did not advance.");
  }
  return {
    sessions: completedSessions(response.sessions),
    next: response.pagination?.has_more ? { cursor } : null,
  };
}
