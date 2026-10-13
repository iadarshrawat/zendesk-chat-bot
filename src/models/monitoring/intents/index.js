import sql from 'mssql';
import { sqlTable } from '../../schema/index.js';
import { executeBoundedSql } from '../../../common/utils/boundedSql/index.js';
import { customerIntent, customerIntentId, customerIntentKey } from '../../../common/monitoring/intent/index.js';

/**
 * Read the complete persistent catalogue for semantic comparison, including unused intents.
 * @param {Object} db - SQL connection pool.
 * @returns {Promise<Array<Object>>} All canonical intents in stable creation order.
 */
export async function listMonitoringIntents(db) {
  const result = await executeBoundedSql(
    db,
    `SELECT intent_id, name, product, description FROM ${sqlTable('bot_monitor_intents')} ORDER BY created_at, intent_id`,
    {},
    { timeoutMs: 10_000, retryRead: true, stage: 'mssql.intent_catalogue' }
  );

  return result.recordset || [];
}

/**
 * Insert only after the compared catalogue is still current; concurrent additions trigger another comparison.
 * @param {Object} db - SQL connection pool.
 * @param {Object} draft - Validated customer intent name, product, and description.
 * @param {number} expectedCount - Number of intents checked by the caller.
 * @returns {Promise<string|null>} Existing/new intent ID, or null when the catalogue changed.
 */
export async function createMonitoringIntent(db, draft, expectedCount) {
  const value = customerIntent(draft);
  if (!value || !Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    throw new TypeError('Invalid intent creation request');
  }
  const intents = sqlTable('bot_monitor_intents');
  const result = await executeBoundedSql(
    db,
    `SET XACT_ABORT ON;
    BEGIN TRY
      BEGIN TRANSACTION;
      DECLARE @lockResult INT, @selectedId CHAR(64) = NULL;
      EXEC @lockResult = sys.sp_getapplock @Resource = 'zendesk-monitor-intent-catalogue',
        @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 5000;
      IF @lockResult < 0 THROW 50001, 'Monitoring intent catalogue is busy', 1;
      IF EXISTS (SELECT 1 FROM ${intents} WHERE intent_id = @intent_id)
        SET @selectedId = @intent_id;
      ELSE IF (SELECT COUNT_BIG(*) FROM ${intents}) = @expectedCount
      BEGIN
        INSERT INTO ${intents} (intent_id, name, product, description, created_at)
          VALUES (@intent_id, @name, @product, @description, SYSUTCDATETIME());
        SET @selectedId = @intent_id;
      END;
      COMMIT TRANSACTION;
      SELECT @selectedId AS intent_id;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
      THROW;
    END CATCH;`,
    { intent_id: customerIntentKey(value), name: value.name, product: value.product, description: value.description, expectedCount },
    {
      timeoutMs: 15_000,
      stage: 'mssql.intent_create',
      parameterTypes: {
        intent_id: sql.Char(64),
        name: sql.NVarChar(240),
        product: sql.NVarChar(160),
        description: sql.NVarChar(1000),
        expectedCount: sql.BigInt
      }
    }
  );

  return customerIntentId(result.recordset?.[0]?.intent_id);
}

/**
 * Read pending sessions, or a fixed historical range for an explicit full reclassification.
 * @param {Object} db - SQL connection pool.
 * @param {string} after - Last inspected session identifier.
 * @param {Object} options - allSessions includes inspected rows; before excludes evaluations saved after the run started.
 * @returns {Promise<Array<Object>>} Up to 50 session identities and their original evidence cutoff.
 */
export async function readMonitoringIntentSessions(db, after = '', { allSessions = false, before = null } = {}) {
  const result = await executeBoundedSql(
    db,
    `SELECT TOP (50) e.session_id, s.ticket_id, e.first_message_id, e.last_message_at, e.intent_id
      FROM ${sqlTable('bot_monitor_evaluations')} AS e
      INNER JOIN ${sqlTable('bot_monitor_sessions')} AS s ON s.session_id = e.session_id
      WHERE (@allSessions = 1 OR e.intent_classified_at IS NULL) AND e.session_id > @after
        AND (@before IS NULL OR e.updated_at <= @before)
      ORDER BY e.session_id`,
    { after, allSessions, before },
    {
      timeoutMs: 10_000,
      retryRead: true,
      stage: 'mssql.intent_history',
      parameterTypes: { after: sql.NVarChar(255), allSessions: sql.Bit, before: sql.DateTime2(3) }
    }
  );

  return result.recordset || [];
}

/**
 * Attach a historical session to a canonical intent without changing its score, dates, or reason.
 * @param {Object} db - SQL connection pool.
 * @param {string} sessionId - Stored session identifier.
 * @param {string|null} intentId - Matched intent, or null when no customer intent was identifiable.
 * @param {Object} options - replaceExisting allows the one-time migration to reclassify inspected sessions.
 * @returns {Promise<boolean>} Whether this session's intent assignment was updated.
 */
export async function assignMonitoringIntent(db, sessionId, intentId, { replaceExisting = false } = {}) {
  const result = await executeBoundedSql(
    db,
    `UPDATE ${sqlTable('bot_monitor_evaluations')} SET intent_id = @intentId, intent_classified_at = SYSUTCDATETIME()
      WHERE session_id = @sessionId AND (@replaceExisting = 1 OR intent_classified_at IS NULL);
      SELECT @@ROWCOUNT AS written;`,
    { sessionId, intentId: customerIntentId(intentId), replaceExisting },
    {
      timeoutMs: 10_000,
      stage: 'mssql.intent_assign',
      parameterTypes: { sessionId: sql.NVarChar(255), intentId: sql.Char(64), replaceExisting: sql.Bit }
    }
  );

  return Boolean(result.recordset?.[0]?.written);
}
