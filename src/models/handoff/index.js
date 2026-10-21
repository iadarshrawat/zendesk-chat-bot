import sql from 'mssql';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../loaders/database/sql/index.js';
import { sqlTable } from '../schema/index.js';
import { executeBoundedSql } from '../../common/utils/boundedSql/index.js';
import { measureStage } from '../../common/utils/timingLogger/index.js';

const SQL_TIMEOUT_MS = 2500;

/**
 * Convert a SQL row to the workflow state used by escalation services.
 * @param {Object} row - Stored handoff row, including validated JSON.
 * @returns {Object|null} Parsed state, or null when no row exists.
 */
function handoffFromRow(row) {
  if (!row) return null;
  const data = JSON.parse(row.data_json);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Invalid persisted handoff data');
  return {
    conversationId: row.conversation_id,
    webUserId: row.web_user_id,
    attemptId: row.attempt_id,
    status: row.status,
    offerMessageId: row.offer_message_id,
    formMessageId: row.form_message_id,
    data,
    revision: row.revision,
    updatedAt: row.updated_at
  };
}

/**
 * Validate the conversation and customer identity used by both repository operations.
 * @param {string} conversationId - Sunshine conversation ID.
 * @param {string} webUserId - Sunshine customer ID.
 * @returns {Object} Validated SQL identity parameters; throws for a missing or oversized ID.
 */
function identityParameters(conversationId, webUserId) {
  for (const value of [conversationId, webUserId]) {
    if (typeof value !== 'string' || !value.trim() || value.length > 128) {
      throw new TypeError('Handoff requires valid conversation and customer IDs');
    }
  }
  return { conversation_id: conversationId, web_user_id: webUserId };
}

/**
 * Read durable handoff state without treating database failures as an empty workflow.
 * @param {string} conversationId - Sunshine conversation ID.
 * @param {string} webUserId - Sunshine customer ID.
 * @returns {Promise<Object|null>} The saved state, or null only when the row is absent.
 */
export async function loadHandoff(conversationId, webUserId) {
  const parameters = identityParameters(conversationId, webUserId);
  const result = await measureStage('handoff.state_load', () =>
    executeBoundedSql(
      getPool(),
      `SELECT * FROM ${sqlTable('bot_conversation_handoffs')}
      WHERE conversation_id = @conversation_id AND web_user_id = @web_user_id`,
      parameters,
      { timeoutMs: SQL_TIMEOUT_MS, retryRead: true }
    )
  );
  return handoffFromRow(result.recordset?.[0]);
}

/**
 * Extract confirmed evidence only; pending or failed attempts never become transfer history.
 * @param {Object} state - Current or previously saved handoff state.
 * @returns {Object|null} Transfer timestamps and message anchors, or null before verified success.
 */
function confirmedTransfer(state) {
  if (!state?.data.confirmedAt) return null;
  const startedAt = new Date(state.data.transferStartedAt);
  const confirmedAt = new Date(state.data.confirmedAt);
  const sourceId = state.data.transferMessageId || null;
  const formId = state.formMessageId || null;
  if ((!sourceId && !formId) || !Number.isFinite(startedAt.getTime()) || !Number.isFinite(confirmedAt.getTime())) return null;
  return { state, sourceId, formId, startedAt, confirmedAt };
}

/**
 * Find verified attempts anchored to this ticket's Sunshine message IDs, including pre-upgrade state.
 * @param {Object} db - SQL connection pool.
 * @param {Array<string>} messageIds - Sunshine IDs extracted from the ticket's conversation log.
 * @returns {Promise<Array<Object>>} Confirmed transfers; failures reject instead of permitting an incorrect normal score.
 */
export async function listConfirmedHandoffTransfers(db, messageIds) {
  if (!messageIds.length) return [];
  const result = await executeBoundedSql(
    db,
    `WITH message_ids AS (SELECT value AS message_id FROM OPENJSON(@messageIds))
    SELECT t.attempt_id, t.source_message_id, t.form_message_id, t.transfer_started_at, t.confirmed_at
      FROM ${sqlTable('bot_handoff_transfers')} AS t
      WHERE t.source_message_id IN (SELECT message_id FROM message_ids)
         OR t.form_message_id IN (SELECT message_id FROM message_ids)
    UNION ALL
    SELECT h.attempt_id, JSON_VALUE(h.data_json, '$.transferMessageId'), h.form_message_id,
      TRY_CONVERT(DATETIME2(3), JSON_VALUE(h.data_json, '$.transferStartedAt'), 127),
      TRY_CONVERT(DATETIME2(3), JSON_VALUE(h.data_json, '$.confirmedAt'), 127)
      FROM ${sqlTable('bot_conversation_handoffs')} AS h
      WHERE JSON_VALUE(h.data_json, '$.confirmedAt') IS NOT NULL
        AND (h.form_message_id IN (SELECT message_id FROM message_ids)
          OR JSON_VALUE(h.data_json, '$.transferMessageId') IN (SELECT message_id FROM message_ids))
        AND NOT EXISTS (SELECT 1 FROM ${sqlTable('bot_handoff_transfers')} AS t WHERE t.attempt_id = h.attempt_id);`,
    { messageIds: JSON.stringify([...new Set(messageIds)]) },
    { timeoutMs: 10_000, retryRead: true, parameterTypes: { messageIds: sql.NVarChar(sql.MAX) } }
  );
  return result.recordset || [];
}

/**
 * Save a revision-checked workflow transition and confirmed transfer evidence in one SQL transaction.
 * @param {Object|null} previous - Loaded state, or null for the customer's first handoff.
 * @param {Object} next - Complete next state, including conversationId and webUserId.
 * @returns {Promise<Object>} Saved state; conflicts and uncertain writes reject without automatic replay.
 */
export async function saveHandoff(previous, next) {
  const transfer = confirmedTransfer(next) || confirmedTransfer(previous);
  const parameters = {
    ...identityParameters(next.conversationId, next.webUserId),
    attempt_id: next.attemptId || randomUUID(),
    status: next.status,
    offer_message_id: next.offerMessageId || null,
    form_message_id: next.formMessageId || null,
    data_json: JSON.stringify(next.data || {}),
    revision: previous?.revision || 0,
    transfer_attempt_id: transfer?.state.attemptId || null,
    transfer_conversation_id: transfer?.state.conversationId || null,
    transfer_web_user_id: transfer?.state.webUserId || null,
    transfer_source_id: transfer?.sourceId || null,
    transfer_form_id: transfer?.formId || null,
    transfer_started_at: transfer?.startedAt || null,
    transfer_confirmed_at: transfer?.confirmedAt || null,
    transfer_mode: transfer?.state.data.supportPolicy?.mode || 'live'
  };
  const result = await measureStage('handoff.state_save', () =>
    executeBoundedSql(
      getPool(),
      `SET XACT_ABORT ON;
     BEGIN TRY
       BEGIN TRANSACTION;
       DECLARE @stateSaved BIT = 0;
       IF @revision = 0
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM ${sqlTable('bot_conversation_handoffs')} WITH (UPDLOCK, HOLDLOCK)
           WHERE conversation_id = @conversation_id AND web_user_id = @web_user_id)
         BEGIN
           INSERT INTO ${sqlTable('bot_conversation_handoffs')}
             (conversation_id, web_user_id, attempt_id, status, offer_message_id, form_message_id,
              data_json, revision, created_at, updated_at)
           OUTPUT INSERTED.* VALUES (@conversation_id, @web_user_id, @attempt_id, @status,
             @offer_message_id, @form_message_id, @data_json, 1, SYSUTCDATETIME(), SYSUTCDATETIME());
           SET @stateSaved = 1;
         END;
       END
       ELSE
       BEGIN
         UPDATE ${sqlTable('bot_conversation_handoffs')} SET attempt_id = @attempt_id, status = @status,
           offer_message_id = @offer_message_id, form_message_id = @form_message_id,
           data_json = @data_json, revision = revision + 1, updated_at = SYSUTCDATETIME()
         OUTPUT INSERTED.*
         WHERE conversation_id = @conversation_id AND web_user_id = @web_user_id AND revision = @revision;
         IF @@ROWCOUNT = 1 SET @stateSaved = 1;
       END;
       IF @stateSaved = 1 AND @transfer_attempt_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${sqlTable('bot_handoff_transfers')} WITH (UPDLOCK, HOLDLOCK) WHERE attempt_id = @transfer_attempt_id)
         INSERT INTO ${sqlTable('bot_handoff_transfers')}
           (attempt_id, conversation_id, web_user_id, source_message_id, form_message_id, transfer_started_at, confirmed_at, support_mode)
         VALUES (@transfer_attempt_id, @transfer_conversation_id, @transfer_web_user_id,
           @transfer_source_id, @transfer_form_id, @transfer_started_at, @transfer_confirmed_at, @transfer_mode);
       COMMIT TRANSACTION;
     END TRY
     BEGIN CATCH
       IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
       THROW;
     END CATCH;`,
      parameters,
      {
        timeoutMs: SQL_TIMEOUT_MS,
        parameterTypes: {
          data_json: sql.NVarChar(sql.MAX),
          transfer_attempt_id: sql.Char(36),
          transfer_conversation_id: sql.NVarChar(128),
          transfer_web_user_id: sql.NVarChar(128),
          transfer_source_id: sql.NVarChar(128),
          transfer_form_id: sql.NVarChar(128),
          transfer_started_at: sql.DateTime2(3),
          transfer_confirmed_at: sql.DateTime2(3),
          transfer_mode: sql.VarChar(16)
        }
      }
    )
  );
  const saved = handoffFromRow(result.recordset?.[0]);
  if (!saved) {
    throw Object.assign(new Error('Handoff changed while this event was processing'), { code: 'HANDOFF_CONFLICT' });
  }
  return saved;
}
