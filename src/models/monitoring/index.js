import sql from 'mssql';
import { sqlTable } from '../schema/index.js';
import { executeBoundedSql } from '../../common/utils/boundedSql/index.js';
import { monitoringRecord } from '../../common/monitoring/validation/index.js';

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
  issue_type: sql.VarChar(32),
  intent_id: sql.Char(64),
  intent_classified_at: sql.DateTime2(3)
};

const REPORT_PARAMETER_TYPES = {
  from: sql.Date,
  to: sql.Date,
  score: sql.VarChar(32),
  search: sql.NVarChar(200),
  intent: sql.VarChar(64),
  pattern: sql.NVarChar(402)
};

/**
 * Build the common FROM and WHERE clauses used by both report views.
 * @returns {string} SQL using bound date, text, and satisfaction parameters.
 */
function reportFilterSql() {
  return `FROM ${sqlTable('bot_monitor_evaluations')} AS e
    INNER JOIN ${sqlTable('bot_monitor_sessions')} AS s ON s.session_id = e.session_id
    LEFT JOIN ${sqlTable('bot_monitor_intents')} AS i ON i.intent_id = e.intent_id
    WHERE e.report_date BETWEEN @from AND @to
      AND (@score = '' OR e.csat_score = @score)
      AND (@intent = '' OR e.intent_id = @intent OR (@intent = 'unidentified' AND e.intent_id IS NULL))
      AND (@search = '' OR s.ticket_id LIKE @pattern ESCAPE '~'
        OR e.ticket_subject LIKE @pattern ESCAPE '~' OR e.reason LIKE @pattern ESCAPE '~'
        OR e.key_issue LIKE @pattern ESCAPE '~' OR i.name LIKE @pattern ESCAPE '~'
        OR i.product LIKE @pattern ESCAPE '~' OR i.description LIKE @pattern ESCAPE '~')`;
}

/**
 * Bind the report dates and filters, escaping LIKE characters as literal text.
 * @returns {Object} Parameter values shared by directory and issue-count queries.
 */
function reportParameters({ from, to, score, search, intent = '' }) {
  return {
    from: new Date(`${from}T00:00:00Z`),
    to: new Date(`${to}T00:00:00Z`),
    score,
    search,
    intent,
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
 * Correct a proven handoff's outcome without rescoring or moving its original reporting dates and intent.
 * @param {Object} db - SQL connection pool.
 * @param {Object} record - Validated session record with the fixed escalated outcome.
 * @returns {Promise<boolean>} True only when a previously non-escalated saved outcome changed.
 */
export async function correctMonitoringEscalation(db, record) {
  const value = monitoringRecord(record);
  if (value.csat_score !== 'escalated' || value.monitoring_status !== 'escalated') throw new TypeError('Escalated outcome required');
  const result = await executeBoundedSql(
    db,
    `UPDATE ${sqlTable('bot_monitor_evaluations')} SET csat_score = 'escalated', monitoring_status = 'escalated',
      human_required = 1, follow_up_required = 1, confidence = @confidence, reason = @reason, updated_at = @updated_at
      WHERE session_id = @session_id AND (csat_score <> 'escalated' OR monitoring_status <> 'escalated');
      SELECT @@ROWCOUNT AS written;`,
    { session_id: value.session_id, confidence: value.confidence, reason: value.reason, updated_at: value.updated_at },
    { timeoutMs: 10_000, parameterTypes: EVALUATION_TYPES }
  );
  return Boolean(result.recordset?.[0]?.written);
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
          .filter(name => !['session_id', 'intent_id', 'intent_classified_at'].includes(name))
          .map(name => `${name} = @${name}`)
          .join(', ')},
          intent_id = CASE WHEN @intent_classified_at IS NULL THEN intent_id ELSE @intent_id END,
          intent_classified_at = COALESCE(@intent_classified_at, intent_classified_at)
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
 * @param {Object} options - Options: from, to, score, search, intent, limit, after.
 * @returns {Promise<Object>} Page rows and hasMore using the existing report ordering.
 */
export async function monitoringPage(db, { from, to, score, search, intent = '', limit, after }) {
  const result = await executeBoundedSql(
    db,
    `SELECT TOP (@rowLimit)
      s.session_id, s.ticket_id, s.session_started_at, s.last_customer_at AS session_last_customer_at,
      s.evaluated_at, e.session_number, e.ticket_subject, e.ticket_created_at,
      e.ticket_requester_id, e.first_message_id AS session_first_message_id,
      e.last_message_at AS session_last_message_at, e.message_count AS session_message_count,
      e.evaluation_due_at, e.report_date, e.csat_score AS score, e.reason,
      e.monitoring_status, e.confidence, e.human_required, e.follow_up_required,
      e.key_issue, e.issue_type, e.updated_at, e.intent_id, e.intent_classified_at,
      i.name AS intent_name, i.product AS intent_product
    ${reportFilterSql()}
      AND (@afterId IS NULL OR e.report_date < @afterDate
        OR (e.report_date = @afterDate AND e.updated_at < @afterUpdated)
        OR (e.report_date = @afterDate AND e.updated_at = @afterUpdated AND e.session_id < @afterId))
    ORDER BY e.report_date DESC, e.updated_at DESC, e.session_id DESC`,
    {
      ...reportParameters({ from, to, score, search, intent }),
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
 * Count all matching sessions and the latest matching session for each ticket, without pagination.
 * @param {Object} db - SQL connection pool.
 * @param {Object} filters - Applied report dates, search text, and satisfaction score.
 * @returns {Promise<Array<Object>>} Session and latest-ticket counts grouped by satisfaction score.
 */
export async function monitoringSummary(db, filters) {
  const result = await executeBoundedSql(
    db,
    `SELECT score, COUNT_BIG(*) AS session_count,
      SUM(CASE WHEN ticket_rank = 1 THEN CAST(1 AS BIGINT) ELSE 0 END) AS ticket_count
    FROM (
      SELECT e.csat_score AS score,
        ROW_NUMBER() OVER (PARTITION BY s.ticket_id
          ORDER BY e.session_number DESC, s.evaluated_at DESC, e.updated_at DESC, e.session_id DESC) AS ticket_rank
      ${reportFilterSql()}
    ) AS matched_sessions
    GROUP BY score`,
    reportParameters(filters),
    {
      timeoutMs: 10_000,
      retryRead: true,
      stage: 'mssql.monitor_summary',
      parameterTypes: REPORT_PARAMETER_TYPES
    }
  );

  return result.recordset || [];
}

/**
 * Count each matching session once by its canonical customer intent across the full applied search.
 * @param {Object} db - SQL connection pool.
 * @param {Object} filters - Existing search filters.
 * @returns {Promise<Array<Object>>} Intent descriptions and counts; unclassified sessions have a null intent ID.
 */
export async function monitoringIssues(db, filters) {
  const result = await executeBoundedSql(
    db,
    `SELECT
      e.intent_id, i.name AS intent_name, i.product, i.description, COUNT_BIG(*) AS session_count
    ${reportFilterSql()}
    GROUP BY e.intent_id, i.name, i.product, i.description
    ORDER BY session_count DESC, intent_name ASC, e.intent_id ASC`,
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

export * from './intents/index.js';
