import sql from "mssql";
import { getPool } from "../../config/sql.js";
import { RAG_CONFIG } from "../../config/rag.js";
import { sqlTable } from "../../config/schema.js";
import { normalizeConversationState } from "./conversationContext.js";
import { logStage, measureStage, safeErrorMetadata } from "../../shared/timingLogger.js";
import { executeBoundedSql } from "../../shared/boundedSql.js";
import { getResponseBudget } from "../../shared/responseBudget.js";

const RECOVERABLE_STATE_ERRORS = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ESOCKET",
  "ECONNCLOSED",
  "ENOTOPEN",
  "ETIMEOUT",
]);
const MILLISECONDS_PER_DAY = 86_400_000;
const DEFAULT_STATE_RETENTION_DAYS = 30;
const STATE_JSON_TYPE = sql.NVarChar(sql.MAX);

function stateRetentionDays() {
  const configured = RAG_CONFIG.conversation.stateDays;
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_STATE_RETENTION_DAYS;
}

function canContinueWithoutSavedState(error, budget) {
  // Never hide the customer turn's actual hard deadline/cancellation.
  if (budget?.signal?.aborted || (budget && budget.remaining() <= 0)) {
    return false;
  }
  if (RECOVERABLE_STATE_ERRORS.has(error?.code)) {
    return true;
  }

  return error?.code === "BOT_RESPONSE_TIMEOUT" && error?.timeoutStage === "mssql.state_load";
}

export async function loadConversationState(conversationId, { db = getPool(), now = Date.now } = {}) {
  const cutoff = new Date(
    now() - stateRetentionDays() * MILLISECONDS_PER_DAY,
  );
  const budget = getResponseBudget();
  let rows;

  try {
    const result = await measureStage(
      "mssql.state_load",
      () => executeBoundedSql(
        db,
        `SELECT state_json FROM ${sqlTable("bot_conversation_state")}
         WHERE conversation_id = @conversation_id AND updated_at >= @cutoff`,
        { conversation_id: conversationId, cutoff },
        {
          retryRead: true,
          stage: "mssql.state_load",
          timeoutMs: Math.min(
            budget?.remaining() ?? Infinity,
            RAG_CONFIG.conversation.stateTimeoutMs ?? 2500,
          ),
          signal: budget?.signal,
          onRetry: ({ error, attempt, maxRetries }) => logStage("mssql.state_read_retry", {
            reason: "transport_reset",
            attempt,
            maxRetries,
            ...safeErrorMetadata(error),
          }),
        },
      ),
      { conversationId },
    );
    rows = result.recordset || [];
  } catch (error) {
    if (!canContinueWithoutSavedState(error, budget)) {
      throw error;
    }

    const reason = error?.timeoutStage === "mssql.state_load"
      ? "state_read_timeout"
      : "state_transport_unavailable";
    const metadata = { reason, ...safeErrorMetadata(error) };

    logStage("mssql.state_load_degraded", metadata);
    console.warn("MSSQL state load unavailable; continuing with conversation history", metadata);
    return normalizeConversationState();
  }

  logStage("mssql.state_load_result", { conversationId, rows: rows.length, found: rows.length > 0 });
  if (!rows.length) {
    return normalizeConversationState();
  }

  try {
    return normalizeConversationState(JSON.parse(rows[0].state_json));
  } catch {
    console.warn("Invalid saved conversation state", conversationId);
    return normalizeConversationState();
  }
}

export async function saveConversationState(conversationId, state, options = {}) {
  const { db = getPool(), ...queryOptions } = options;
  await measureStage(
    "mssql.state_save",
    () => executeBoundedSql(
      db,
      `SET XACT_ABORT ON;
       BEGIN TRY
         BEGIN TRANSACTION;
         UPDATE ${sqlTable("bot_conversation_state")} WITH (UPDLOCK, HOLDLOCK)
         SET state_json = @state_json, updated_at = SYSUTCDATETIME()
         WHERE conversation_id = @conversation_id;
         IF @@ROWCOUNT = 0
           INSERT INTO ${sqlTable("bot_conversation_state")}
             (conversation_id, state_json, updated_at)
           VALUES (@conversation_id, @state_json, SYSUTCDATETIME());
         COMMIT TRANSACTION;
       END TRY
       BEGIN CATCH
         IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
         THROW;
       END CATCH;`,
      {
        conversation_id: conversationId,
        state_json: JSON.stringify(normalizeConversationState(state)),
      },
      {
        ...queryOptions,
        parameterTypes: { state_json: STATE_JSON_TYPE },
        stage: "mssql.state_save",
      },
    ),
    { conversationId },
  );
}
