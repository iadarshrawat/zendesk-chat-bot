import { getPool } from '../../loaders/database/sql/index.js';
import { safeErrorMetadata } from '../../common/utils/timingLogger/index.js';
import { monitoringIssues, monitoringPage } from '../../models/monitoring/index.js';
import { reportFilters } from '../../middlewares/validation/monitoring/index.js';
import { sessionFromRow, summarizeSessions, rankIssueCounts } from '../../common/monitoring/reportData/index.js';

/**
 * Validate a search, read one session page, and return the existing summary and cursor response.
 * @param {Object} req - Express request.
 * @param {Object} res - Express response.
 * @returns {Promise<Object>} The Express response with session data or the existing safe error.
 */
export async function generateReport(req, res) {
  let filters;
  try {
    filters = reportFilters(req.query);
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
  try {
    const page = await monitoringPage(getPool(), filters);
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
      applied_filters: { intent: filters.intent || null },
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
}

/**
 * Validate applied filters and return issue counts across every matching session.
 * @param {Object} req - Express request.
 * @param {Object} res - Express response.
 * @returns {Promise<Object>} The Express response with canonical intent counts or the existing safe error.
 */
export async function generateIssues(req, res) {
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
    const rows = await monitoringIssues(getPool(), filters);
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
}
