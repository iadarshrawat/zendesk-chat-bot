import test from "node:test";
import assert from "node:assert/strict";
import sql from "mssql";
import { sqlTable } from "../../config/schema.js";
import {
  loadConversationState,
  saveConversationState,
} from "./conversationStateService.js";

function recordingPool(result = { recordset: [] }) {
  const requests = [];
  return {
    requests,
    request() {
      const request = {
        inputs: {},
        types: {},
        input(name, type, value) {
          if (arguments.length === 2) this.inputs[name] = type;
          else {
            this.types[name] = type;
            this.inputs[name] = value;
          }
          return this;
        },
        async query(sql) {
          this.sql = sql;
          return result;
        },
        cancel() {},
      };
      requests.push(request);
      return request;
    },
  };
}

test("state loads from a named-parameter MSSQL read with a valid retention cutoff", async () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  const db = recordingPool({
    recordset: [{ state_json: JSON.stringify({ activeRequest: "Need a fan" }) }],
  });

  const state = await loadConversationState("conversation-1", { db, now: () => now });

  assert.equal(state.activeRequest, "Need a fan");
  assert.ok(db.requests[0].sql.includes(`FROM ${sqlTable("bot_conversation_state")}`));
  assert.match(db.requests[0].sql, /conversation_id = @conversation_id/);
  assert.equal(db.requests[0].inputs.conversation_id, "conversation-1");
  assert.ok(db.requests[0].inputs.cutoff instanceof Date);
  assert.ok(Number.isFinite(db.requests[0].inputs.cutoff.getTime()));
  assert.ok(db.requests[0].inputs.cutoff.getTime() < now);
});

test("state save uses one parameterized, transactional SQL Server upsert", async () => {
  const db = recordingPool({ recordset: [] });

  await saveConversationState(
    "conversation-1",
    { activeRequest: "Need a fan", facts: [] },
    { db, timeoutMs: 500 },
  );

  const request = db.requests[0];
  assert.match(request.sql, /BEGIN TRANSACTION/);
  assert.ok(request.sql.includes(`UPDATE ${sqlTable("bot_conversation_state")} WITH (UPDLOCK, HOLDLOCK)`));
  assert.match(request.sql, /IF @@ROWCOUNT = 0/);
  assert.ok(request.sql.includes(`INSERT INTO ${sqlTable("bot_conversation_state")}`));
  assert.match(request.sql, /ROLLBACK TRANSACTION/);
  assert.match(request.sql, /THROW/);
  assert.equal(request.inputs.conversation_id, "conversation-1");
  assert.equal(JSON.parse(request.inputs.state_json).activeRequest, "Need a fan");
  assert.equal(request.types.state_json.length, sql.MAX);
  assert.equal(db.requests.length, 1);
});
