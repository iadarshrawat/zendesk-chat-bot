import sql from 'mssql';
import { sqlTable } from '../schema.js';
import { executeBoundedSql } from '../../common/utils/boundedSql.js';
import { monitoringRecord } from '../../common/monitoring/index.js';

const EVALUATION_TYPES = {
  session_id: sql.NVarChar(255),
  session_number: sql.Int,
  ticket_subject: sql.NVarChar(1024),
  ticket_created_at: sql.DateTime2(3),
  ticket_requester_id: sql.NVarChar(128),
  first_message_id: sql.NVarChar(128),
  last_message_at: sql.DateTime2(3),
  message_count: sql.Int,
  evaluation_due_at: sql.DateTime2(3),
  report_date: sql.Date,
  csat_score: sql.VarChar(32),
  reason: sql.NVarChar(4000),
  monitoring_status: sql.VarChar(16),
  confidence: sql.VarChar(8),
  human_required: sql.Bit,
  follow_up_required: sql.Bit,
  key_issue: sql.NVarChar(1024),
  updated_at: sql.DateTime2(3),
  issue_type: sql.VarChar(32)
};

const REPORT_PARAMETER_TYPES = {
  from: sql.Date,
  to: sql.Date,
  score: sql.VarChar(32),
  search: sql.NVarChar(200),
  pattern: sql.NVarChar(402)
};

/**
 * Build the common FROM and WHERE clauses used by both report views.
 * @returns {string} SQL using bound date, text, and satisfaction parameters.
 */
function reportFilterSql() {
  return `FROM ${sqlTable('bot_monitor_evaluations')} AS e
    INNER JOIN ${sqlTable('bot_monitor_sessions')} AS s ON s.session_id = e.session_id
    WHERE e.report_date BETWEEN @from AND @to
      AND (@score = '' OR e.csat_score = @score)
      AND (@search = '' OR s.ticket_id LIKE @pattern ESCAPE '~'
        OR e.ticket_subject LIKE @pattern ESCAPE '~' OR e.reason LIKE @pattern ESCAPE '~'
        OR e.key_issue LIKE @pattern ESCAPE '~')`;
}

/**
 * Bind the report dates and filters, escaping LIKE characters as literal text.
 * @returns {Object} Parameter values shared by directory and issue-count queries.
 */
function reportParameters({ from, to, score, search }) {
  return {
    from: new Date(`${from}T00:00:00Z`),
    to: new Date(`${to}T00:00:00Z`),
    score,
    search,
    pattern: `%${search.replace(/[~%_\[]/g, character => `~${character}`)}%`
  };
}

/**
 * Read persisted session IDs so completed sessions are never scored again.
 * @param {Object} db - SQL connection pool.
 * @param {string|number} ticketId - Zendesk ticket ID.
 * @returns {Promise<Set<string>>} The completed session IDs for one ticket.
 */
export async function completedSessionIds(db, ticketId) {
  const result = await db.request().input('ticketId', sql.NVarChar(32), String(ticketId))
    .query(`SELECT session_id FROM ${sqlTable('bot_monitor_sessions')}
      WHERE ticket_id = @ticketId`);

  return new Set((result.recordset || []).map(row => row.session_id));
}

/**
 * Validate and transactionally commit session metadata and evaluation data together.
 * @param {Object} db - SQL connection pool.
 * @param {Object} record - Monitoring data to validate.
 * @param {Object} options - Options: replaceOlder.
 * @returns {Promise<boolean>} Whether a new or explicitly newer evaluation was written.
 */
export async function saveMonitoringSession(db, record, { replaceOlder = false } = {}) {
  const value = monitoringRecord(record);
  const sessions = sqlTable('bot_monitor_sessions');
  const evaluations = sqlTable('bot_monitor_evaluations');
  const columns = Object.keys(EVALUATION_TYPES);
  const query = `SET XACT_ABORT ON;
    BEGIN TRY
      BEGIN TRANSACTION;
      DECLARE @written BIT = 0;
      IF NOT EXISTS (SELECT 1 FROM ${sessions} WITH (UPDLOCK, HOLDLOCK) WHERE session_id = @session_id)
        INSERT INTO ${sessions}
          (session_id, ticket_id, session_started_at, last_customer_at, record_external_id, evaluated_at)
        VALUES (@session_id, @ticket_id, @session_started_at, @last_customer_at, @session_id, @evaluated_at);
      IF NOT EXISTS (SELECT 1 FROM ${evaluations} WITH (UPDLOCK, HOLDLOCK) WHERE session_id = @session_id)
      BEGIN
        INSERT INTO ${evaluations} (${columns.join(', ')}) VALUES (${columns.map(name => `@${name}`).join(', ')});
        SET @written = 1;
      END
      ELSE IF @replaceOlder = 1
      BEGIN
        UPDATE ${evaluations} SET ${columns
          .filter(name => name !== 'session_id')
          .map(name => `${name} = @${name}`)
          .join(', ')}
          WHERE session_id = @session_id AND updated_at < @updated_at;
        IF @@ROWCOUNT > 0 SET @written = 1;
      END;
      IF @written = 1
        UPDATE ${sessions} SET ticket_id = @ticket_id, session_started_at = @session_started_at,
          last_customer_at = @last_customer_at, evaluated_at = @evaluated_at WHERE session_id = @session_id;
      COMMIT TRANSACTION;
      SELECT @written AS written;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
      THROW;
    END CATCH;`;
  const result = await executeBoundedSql(
    db,
    query,
    { ...value, replaceOlder },
    {
      timeoutMs: 15_000,
      stage: 'mssql.monitor_save',
      parameterTypes: {
        ...EVALUATION_TYPES,
        ticket_id: sql.NVarChar(32),
        session_started_at: sql.DateTime2(3),
        last_customer_at: sql.DateTime2(3),
        evaluated_at: sql.DateTime2(3),
        replaceOlder: sql.Bit
      }
    }
  );

  return Boolean(result.recordset?.[0]?.written);
}

/**
 * Read one bounded, filtered session page and check whether another cursor page exists.
 * @param {Object} db - SQL connection pool.
 * @param {Object} options - Options: from, to, score, search, limit, after.
 * @returns {Promise<Object>} Page rows and hasMore using the existing report ordering.
 */
export async function monitoringPage(db, { from, to, score, search, limit, after }) {
  const result = await executeBoundedSql(
    db,
    `SELECT TOP (@rowLimit)
      s.session_id, s.ticket_id, s.session_started_at, s.last_customer_at AS session_last_customer_at,
      s.evaluated_at, e.session_number, e.ticket_subject, e.ticket_created_at,
      e.ticket_requester_id, e.first_message_id AS session_first_message_id,
      e.last_message_at AS session_last_message_at, e.message_count AS session_message_count,
      e.evaluation_due_at, e.report_date, e.csat_score AS score, e.reason,
      e.monitoring_status, e.confidence, e.human_required, e.follow_up_required,
      e.key_issue, e.issue_type, e.updated_at
    ${reportFilterSql()}
      AND (@afterId IS NULL OR e.report_date < @afterDate
        OR (e.report_date = @afterDate AND e.updated_at < @afterUpdated)
        OR (e.report_date = @afterDate AND e.updated_at = @afterUpdated AND e.session_id < @afterId))
    ORDER BY e.report_date DESC, e.updated_at DESC, e.session_id DESC`,
    {
      ...reportParameters({ from, to, score, search }),
      rowLimit: limit + 1,
      afterId: after?.session_id || null,
      afterDate: after ? new Date(`${after.report_date}T00:00:00Z`) : null,
      afterUpdated: after ? new Date(after.updated_at) : null
    },
    {
      timeoutMs: 10_000,
      retryRead: true,
      stage: 'mssql.monitor_report',
      parameterTypes: {
        ...REPORT_PARAMETER_TYPES,
        rowLimit: sql.Int,
        afterId: sql.NVarChar(255),
        afterDate: sql.Date,
        afterUpdated: sql.DateTime2(3)
      }
    }
  );
  const rows = result.recordset || [];

  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * Count each matching session once by its primary issue across the full applied search.
 * @param {Object} db - SQL connection pool.
 * @param {Object} filters - Existing search filters.
 * @returns {Promise<Array<Object>>} SQL categories and counts in descending frequency; legacy nulls remain unknown.
 */
export async function monitoringIssues(db, filters) {
  const result = await executeBoundedSql(
    db,
    `SELECT
      COALESCE(e.issue_type, 'unknown') AS issue_type, COUNT_BIG(*) AS session_count
    ${reportFilterSql()}
    GROUP BY COALESCE(e.issue_type, 'unknown')
    ORDER BY session_count DESC, issue_type ASC`,
    reportParameters(filters),
    {
      timeoutMs: 10_000,
      retryRead: true,
      stage: 'mssql.monitor_issues',
      parameterTypes: REPORT_PARAMETER_TYPES
    }
  );

  return result.recordset || [];
}
