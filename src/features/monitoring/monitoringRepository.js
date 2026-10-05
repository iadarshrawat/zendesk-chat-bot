import sql from "mssql";
import { sqlTable } from "../../config/schema.js";

/** A completed session is never sent to the LLM again. */
export async function completedSessionIds(db, ticketId) {
  const result = await db.request()
    .input("ticketId", sql.NVarChar(32), String(ticketId))
    .query(`SELECT session_id FROM ${sqlTable("bot_monitor_sessions")}
      WHERE ticket_id = @ticketId`);

  return new Set(result.recordset.map(row => row.session_id));
}

export async function recordCompletedSession(db, ticketId, session, externalId, evaluatedAt) {
  const table = sqlTable("bot_monitor_sessions");
  const query = `INSERT INTO ${table}
    (session_id, ticket_id, session_started_at, last_customer_at, record_external_id, evaluated_at)
    SELECT @sessionId, @ticketId, @startedAt, @lastCustomerAt, @externalId, @evaluatedAt
    WHERE NOT EXISTS (
      SELECT 1 FROM ${table} WITH (UPDLOCK, HOLDLOCK) WHERE session_id = @sessionId
    )`;

  await db.request()
    .input("sessionId", sql.NVarChar(255), externalId)
    .input("ticketId", sql.NVarChar(32), String(ticketId))
    .input("startedAt", sql.DateTime2(3), new Date(session.startedAt))
    .input("lastCustomerAt", sql.DateTime2(3), new Date(session.lastCustomerAt))
    .input("externalId", sql.NVarChar(255), externalId)
    .input("evaluatedAt", sql.DateTime2(3), new Date(evaluatedAt))
    .query(query);
}
