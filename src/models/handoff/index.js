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
 * Save a workflow transition only if its previously loaded revision is still current.
 * @param {Object|null} previous - Loaded state, or null for the customer's first handoff.
 * @param {Object} next - Complete next state, including conversationId and webUserId.
 * @returns {Promise<Object>} Saved state; conflicts and uncertain writes reject without automatic replay.
 */
export async function saveHandoff(previous, next) {
  const parameters = {
    ...identityParameters(next.conversationId, next.webUserId),
    attempt_id: next.attemptId || randomUUID(),
    status: next.status,
    offer_message_id: next.offerMessageId || null,
    form_message_id: next.formMessageId || null,
    data_json: JSON.stringify(next.data || {}),
    revision: previous?.revision || 0
  };
  const result = await measureStage('handoff.state_save', () =>
    executeBoundedSql(
      getPool(),
      `SET XACT_ABORT ON;
     BEGIN TRY
       BEGIN TRANSACTION;
       IF @revision = 0
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM ${sqlTable('bot_conversation_handoffs')} WITH (UPDLOCK, HOLDLOCK)
           WHERE conversation_id = @conversation_id AND web_user_id = @web_user_id)
           INSERT INTO ${sqlTable('bot_conversation_handoffs')}
             (conversation_id, web_user_id, attempt_id, status, offer_message_id, form_message_id,
              data_json, revision, created_at, updated_at)
           OUTPUT INSERTED.* VALUES (@conversation_id, @web_user_id, @attempt_id, @status,
             @offer_message_id, @form_message_id, @data_json, 1, SYSUTCDATETIME(), SYSUTCDATETIME());
       END
       ELSE
         UPDATE ${sqlTable('bot_conversation_handoffs')} SET attempt_id = @attempt_id, status = @status,
           offer_message_id = @offer_message_id, form_message_id = @form_message_id,
           data_json = @data_json, revision = revision + 1, updated_at = SYSUTCDATETIME()
         OUTPUT INSERTED.*
         WHERE conversation_id = @conversation_id AND web_user_id = @web_user_id AND revision = @revision;
       COMMIT TRANSACTION;
     END TRY
     BEGIN CATCH
       IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
       THROW;
     END CATCH;`,
      parameters,
      { timeoutMs: SQL_TIMEOUT_MS, parameterTypes: { data_json: sql.NVarChar(sql.MAX) } }
    )
  );
  const saved = handoffFromRow(result.recordset?.[0]);
  if (!saved) {
    throw Object.assign(new Error('Handoff changed while this event was processing'), { code: 'HANDOFF_CONFLICT' });
  }
  return saved;
}
