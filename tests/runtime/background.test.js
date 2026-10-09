import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundRuntime } from '../../src/common/cron/index.js';

function createDeferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });

  return { promise, resolve };
}

async function waitFor(promise, timeoutMs = 500) {
  let timer;

  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Background loop did not wake promptly')), timeoutMs);
    });

    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test('an accepted webhook wakes the idle inbox immediately and shutdown stops both loops', async () => {
  const firstJob = createDeferred();
  const secondJob = createDeferred();
  let jobCalls = 0;
  let monitorCalls = 0;

  const runtime = createBackgroundRuntime({
    processJob: async () => {
      jobCalls++;
      if (jobCalls === 1) {
        firstJob.resolve();
      } else {
        secondJob.resolve();
      }

      return false;
    },
    runMonitor: async () => {
      monitorCalls++;
    },
    pollMs: 10_000,
    monitorMs: 10_000,
    logger: {
      log() {},
      error(error) {
        throw error;
      }
    }
  }).start();

  try {
    await waitFor(firstJob.promise);
    runtime.notify();
    await waitFor(secondJob.promise);
    assert.equal(monitorCalls, 1);
  } finally {
    await waitFor(runtime.stop());
  }
});

test('a notification during an empty queue check cannot be lost', async () => {
  const firstJob = createDeferred();
  const nextJob = createDeferred();
  const releaseClaim = createDeferred();
  let jobCalls = 0;

  const runtime = createBackgroundRuntime({
    processJob: async () => {
      jobCalls++;
      if (jobCalls === 1) {
        firstJob.resolve();
        await releaseClaim.promise;
      } else {
        nextJob.resolve();
      }

      return false;
    },
    runMonitor: async () => {},
    pollMs: 10_000,
    monitorMs: 10_000,
    logger: {
      log() {},
      error(error) {
        throw error;
      }
    }
  }).start();

  try {
    await waitFor(firstJob.promise);
    runtime.notify();
    releaseClaim.resolve();
    await waitFor(nextJob.promise);
  } finally {
    releaseClaim.resolve();
    await waitFor(runtime.stop());
  }
});
