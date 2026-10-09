export function toIsoString(time) {
  return new Date(time).toISOString();
}

/**
 * Accept only real UTC calendar dates written as YYYY-MM-DD.
 * @param {string} value - Candidate report date.
 * @returns {boolean} Whether the format and calendar date are valid.
 */
export function validReportDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);

  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Calculate the end of a one-calendar-year range, including leap-day starts.
 * @param {string} from - Valid YYYY-MM-DD start date.
 * @returns {string} The latest allowed YYYY-MM-DD end date.
 */
export function latestReportEndDate(from) {
  const date = new Date(`${from}T00:00:00Z`);
  const year = date.getUTCFullYear() + 1;
  const month = date.getUTCMonth();

  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate())))
    .toISOString()
    .slice(0, 10);
}
