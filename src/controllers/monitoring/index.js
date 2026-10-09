import { getPool } from '../../loaders/database/sql.js';
import { safeErrorMetadata } from '../../common/utils/timingLogger.js';
import { monitoringIssues, monitoringPage } from '../../models/monitoring/index.js';
import { reportFilters } from '../../middlewares/validation/monitoring/index.js';
import { sessionFromRow, summarizeSessions, rankIssueCounts } from '../../common/monitoring/reportData.js';

/**
 * Bind SQL report dependencies to the existing filtered session-report HTTP handler.
 * @param {Object} options - Options: db, readPage.
 * @returns {Function} An async Express handler returning the existing paginated response.
 */
export function createReportController({ db = getPool, readPage = monitoringPage } = {}) {
  /**
   * Validate a search, read one session page, and return the existing summary and cursor response.
   * @param {Object} req - Express request.
   * @param {Object} res - Express response.
   * @returns {Promise<Object>} The Express response with session data or the existing safe error.
   */
  return async function generateReport(req, res) {
    let filters;
    try {
      filters = reportFilters(req.query);
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
    try {
      const page = await readPage(typeof db === 'function' ? db() : db, filters);
      const sessions = page.rows.map(sessionFromRow);
      const last = sessions.at(-1);
      const cursor =
        page.hasMore && last
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                filters: filters.fingerprint,
                report_date: last.report_date,
                updated_at: last.updated_at,
                session_id: last.session_id
              })
            ).toString('base64url')
          : null;
      res.set('Cache-Control', 'no-store');

      return res.status(200).json({
        success: true,
        generated_at: new Date().toISOString(),
        date_range: { from: filters.from, to: filters.to },
        summary: summarizeSessions(sessions),
        sessions,
        tickets: sessions,
        pagination: {
          limit: filters.limit,
          has_more: page.hasMore,
          next_cursor: cursor
        }
      });
    } catch (error) {
      console.error('SQL monitoring report unavailable', safeErrorMetadata(error));

      return res.status(503).json({
        success: false,
        error: 'Monitoring data is temporarily unavailable.'
      });
    }
  };
}

export const generateReport = createReportController();

/**
 * Bind SQL issue-count dependencies to the existing full-search monitoring HTTP handler.
 * @param {Object} options - Options: db, readIssues.
 * @returns {Function} An async Express handler returning ranked issue counts.
 */
export function createIssuesController({ db = getPool, readIssues = monitoringIssues } = {}) {
  /**
   * Validate applied filters and return issue counts across every matching session.
   * @param {Object} req - Express request.
   * @param {Object} res - Express response.
   * @returns {Promise<Object>} The Express response with category counts or the existing safe error.
   */
  return async function generateIssues(req, res) {
    let filters;
    try {
      filters = reportFilters({
        from: req.query.from,
        to: req.query.to,
        search: req.query.search,
        score: req.query.score
      });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
    try {
      const rows = await readIssues(typeof db === 'function' ? db() : db, filters);
      const { issues, totalSessions } = rankIssueCounts(rows);
      res.set('Cache-Control', 'no-store');

      return res.status(200).json({
        success: true,
        scope: 'search',
        generated_at: new Date().toISOString(),
        date_range: { from: filters.from, to: filters.to },
        total_sessions: totalSessions,
        issues
      });
    } catch (error) {
      console.error('SQL monitoring issues unavailable', safeErrorMetadata(error));

      return res.status(503).json({
        success: false,
        error: 'Monitoring issue data is temporarily unavailable.'
      });
    }
  };
}

export const generateIssues = createIssuesController();
