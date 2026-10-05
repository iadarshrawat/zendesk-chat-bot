import { completedSessions } from "./reportData.js";

const SEARCH_PATH = "/api/v2/custom_objects/ticket_csat_scores/records/search";
const PAGE_SIZE = 20;
const COMPLETED_STATUSES = ["evaluated", "escalated"];

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? null : date;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
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
  const nextYear = start.getUTCFullYear() + 1;
  const month = start.getUTCMonth();
  const lastDay = new Date(Date.UTC(nextYear, month + 1, 0)).getUTCDate();
  return isoDate(new Date(Date.UTC(nextYear, month, Math.min(start.getUTCDate(), lastDay))));
}

// Report date is a text field in Zendesk. Equality is supported; range
// comparisons are not. Group daily equality filters by month to keep each
// request small, while Zendesk still filters before sending us a page.
function dateGroups(from, to) {
  const groups = new Map();
  const day = parseDate(to);
  const first = parseDate(from);
  while (day >= first) {
    const date = isoDate(day);
    const month = date.slice(0, 7);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(date);
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return [...groups.values()];
}

function searchFilter(dates, score) {
  const conditions = [
    { $or: dates.map((date) => ({ "custom_object_fields.report_date": { $eq: date } })) },
    { $or: COMPLETED_STATUSES.map((status) => ({ "custom_object_fields.monitoring_status": { $eq: status } })) },
  ];
  if (score) conditions.push({ "custom_object_fields.csat_score": { $eq: score } });
  return { filter: { $and: conditions } };
}

/** Fetch just one Zendesk page. `position` is a small cursor, not a record cache. */
export async function fetchMonitoringPage(client, filters, position = { group: 0, cursor: null }) {
  const error = validateDateRange(filters.from, filters.to);
  if (error) throw new Error(error);

  const groups = dateGroups(filters.from, filters.to);
  let { group, cursor } = position;
  const seenCursors = new Set();

  while (group < groups.length) {
    const params = new URLSearchParams({ "page[size]": String(PAGE_SIZE), sort: "-updated_at" });
    if (cursor) params.set("page[after]", cursor);
    if (filters.search?.trim()) params.set("query", filters.search.trim());

    const response = await client.request({
      url: `${SEARCH_PATH}?${params}`,
      type: "POST",
      contentType: "application/json",
      dataType: "json",
      data: JSON.stringify(searchFilter(groups[group], filters.score)),
      cache: false,
      autoRetry: true,
    });
    const records = response.custom_object_records || response.results || [];
    const sessions = completedSessions(records)
      .filter((session) => session.reportDate >= filters.from && session.reportDate <= filters.to);

    let next = null;
    if (response.meta?.has_more) {
      const nextCursor = response.meta.after_cursor;
      if (!nextCursor || nextCursor === cursor || seenCursors.has(`${group}:${nextCursor}`)) {
        throw new Error("Zendesk record pagination stopped before the next page.");
      }
      seenCursors.add(`${group}:${nextCursor}`);
      next = { group, cursor: nextCursor };
    } else if (group + 1 < groups.length) {
      next = { group: group + 1, cursor: null };
    }

    if (sessions.length || !next) return { sessions, next };
    ({ group, cursor } = next);
  }

  return { sessions: [], next: null };
}
