import test from 'node:test';
import assert from 'node:assert/strict';
import { runExclusiveMonitor } from '../../src/services/monitoring/worker.js';

function fakePool(lockCode) {
  const calls = [];
  const transaction = {
    async begin() {
      calls.push('begin');
    },
    request() {
      return {
        input(name, value) {
          assert.equal(name, 'resource');
          assert.equal(value, 'zendesk-bot-monitor-v1');

          return this;
        },
        async query(query) {
          assert.match(query, /sys\.sp_getapplock/);
          assert.match(query, /@LockOwner = 'Transaction'/);
          calls.push('lock');

          return { recordset: [{ acquired: lockCode }] };
        }
      };
    },
    async rollback() {
      calls.push('rollback');
    }
  };

  return { calls, transaction: () => transaction };
}

test('monitor holds a SQL Server application lock for the report', async () => {
  const pool = fakePool(0);
  const result = await runExclusiveMonitor({
    pool,
    report: async () => {
      pool.calls.push('report');

      return { success: true };
    }
  });

  assert.equal(result.success, true);
  assert.deepEqual(pool.calls, ['begin', 'lock', 'report', 'rollback']);
});

test('monitor skips a poll when another process owns the lock', async () => {
  const pool = fakePool(-1);
  const result = await runExclusiveMonitor({
    pool,
    report: () => {
      throw new Error('Report must not run');
    }
  });

  assert.deepEqual(result, { skipped: true });
  assert.deepEqual(pool.calls, ['begin', 'lock', 'rollback']);
});

test('monitor releases the lock after a report failure', async () => {
  const pool = fakePool(0);
  await assert.rejects(
    runExclusiveMonitor({
      pool,
      report: async () => ({ success: false, error: 'Failed' })
    }),
    /Failed/
  );
  assert.deepEqual(pool.calls, ['begin', 'lock', 'rollback']);
});
