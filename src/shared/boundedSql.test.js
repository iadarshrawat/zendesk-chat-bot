import test from "node:test";
import assert from "node:assert/strict";
import { executeBoundedSql } from "./boundedSql.js";

function fakePool(runQuery) {
  const requests = [];
  return {
    requests,
    request() {
      const request = {
        inputs: {},
        cancelled: false,
        input(name, value) {
          this.inputs[name] = value;
          return this;
        },
        query(sql) {
          this.sql = sql;
          return runQuery(this, requests.length);
        },
        cancel() {
          this.cancelled = true;
          return true;
        },
      };
      requests.push(request);
      return request;
    },
  };
}

test("SQL Server requests use named parameters and return the driver's result", async () => {
  const expected = { recordset: [{ state_json: "{}" }] };
  const pool = fakePool(() => expected);

  const result = await executeBoundedSql(
    pool,
    "SELECT state_json FROM t WHERE conversation_id = @conversation_id",
    { conversation_id: "conversation-1" },
  );

  assert.equal(result, expected);
  assert.deepEqual(pool.requests[0].inputs, { conversation_id: "conversation-1" });
  assert.equal(pool.requests.length, 1);
});

test("a transient failure retries a safe read once but never retries a locking read", async () => {
  let attempts = 0;
  const pool = fakePool(() => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("socket closed"), { code: "ESOCKET" });
    return { recordset: [{ value: 1 }] };
  });
  const retries = [];

  const result = await executeBoundedSql(pool, "SELECT value FROM t", {}, {
    retryRead: true,
    onRetry: details => retries.push(details),
  });

  assert.deepEqual(result.recordset, [{ value: 1 }]);
  assert.equal(pool.requests.length, 2);
  assert.equal(retries.length, 1);

  const lockingPool = fakePool(() => {
    throw Object.assign(new Error("socket closed"), { code: "ESOCKET" });
  });
  await assert.rejects(
    executeBoundedSql(lockingPool, "SELECT value FROM t WITH (UPDLOCK)", {}, { retryRead: true }),
    { code: "ESOCKET" },
  );
  assert.equal(lockingPool.requests.length, 1);
});

test("a deadline cancels the active SQL Server request", async () => {
  const pool = fakePool(() => new Promise(() => {}));

  await assert.rejects(
    executeBoundedSql(pool, "SELECT value FROM t", {}, {
      timeoutMs: 10,
      stage: "mssql.test_deadline",
    }),
    { code: "BOT_RESPONSE_TIMEOUT", timeoutStage: "mssql.test_deadline" },
  );
  assert.equal(pool.requests[0].cancelled, true);
});
