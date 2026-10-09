import { createHash } from 'node:crypto';
import { validReportDate, latestReportEndDate } from '../../../common/utils/dates.js';
import { MONITORING_SCORES } from '../../../common/monitoring/index.js';

function filterHash(filters) {
  return createHash('sha256').update(JSON.stringify(filters)).digest('hex').slice(0, 32);
}

/**
 * Validate report dates, score, text, limit, and cursor ownership before a SQL read.
 * @param {Object} query - Incoming report query parameters.
 * @param {string} today - UTC report-date default.
 * @returns {Object} Normalized filters, their fingerprint, and any validated cursor position.
 */
export function reportFilters(query, today = new Date().toISOString().slice(0, 10)) {
  const filters = {
    from: query.from ?? today,
    to: query.to ?? today,
    score: query.score ?? '',
    search: query.search ?? '',
    limit: query.limit ?? '20'
  };
  if (
    !validReportDate(filters.from) ||
    !validReportDate(filters.to) ||
    filters.from > filters.to ||
    filters.to > latestReportEndDate(filters.from)
  ) {
    throw new TypeError('Select valid report dates in order, no more than one year apart.');
  }
  if (typeof filters.score !== 'string' || (filters.score && !MONITORING_SCORES.includes(filters.score))) {
    throw new TypeError('Invalid satisfaction score.');
  }
  if (typeof filters.search !== 'string' || filters.search.length > 200) {
    throw new TypeError('Search text must be no more than 200 characters.');
  }
  filters.search = filters.search.trim();
  if (typeof filters.limit !== 'string' || !/^\d+$/.test(filters.limit) || Number(filters.limit) < 1 || Number(filters.limit) > 100) {
    throw new TypeError('Page limit must be between 1 and 100.');
  }
  filters.limit = Number(filters.limit);
  const fingerprint = filterHash(filters);
  let after = null;
  if (query.cursor != null) {
    if (typeof query.cursor !== 'string' || query.cursor.length > 1500 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) {
      throw new TypeError('Invalid page cursor.');
    }
    try {
      after = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (
        after.version !== 1 ||
        after.filters !== fingerprint ||
        !validReportDate(after.report_date) ||
        after.report_date < filters.from ||
        after.report_date > filters.to ||
        typeof after.session_id !== 'string' ||
        after.session_id.length > 255 ||
        !/^ai-monitor:v2:\d+:.+$/.test(after.session_id) ||
        typeof after.updated_at !== 'string' ||
        !Number.isFinite(Date.parse(after.updated_at))
      ) {
        throw new Error('Invalid cursor');
      }
    } catch {
      throw new TypeError('Page cursor is invalid or belongs to a different search.');
    }
  }

  return { ...filters, after, fingerprint };
}
