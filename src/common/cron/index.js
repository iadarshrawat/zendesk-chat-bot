import { randomUUID } from 'node:crypto';
import { processOneInboxJob } from '../../services/messaging/worker/index.js';
import { runExclusiveMonitor } from '../../services/monitoring/worker/index.js';
import { MONITORING_CONFIG } from '../../config/monitoring/index.js';
import { RAG_CONFIG } from '../../config/rag/index.js';
import { safeErrorMetadata } from '../utils/timingLogger/index.js';

/**
 * Create inbox and monitoring loops with the existing wakeup, polling, and shutdown rules.
 * @param {Object} options - Worker concurrency, job/monitor operations, polling intervals and logger.
 * @returns {Object} start, notify, and stop operations for one background runtime.
 */
export function createBackgroundRuntime({
  processJob = processOneInboxJob,
  runMonitor = runExclusiveMonitor,
  pollMs = 750,
  errorDelayMs = 5_000,
  monitorMs = MONITORING_CONFIG.pollIntervalMs,
  inboxConcurrency = RAG_CONFIG.conversation.inboxConcurrency,
  logger = console
} = {}) {
  let running = false;
  let started = false;
  let inboxNotificationVersion = 0;
  if (!Number.isInteger(inboxConcurrency) || inboxConcurrency < 1 || inboxConcurrency > 8) {
    throw new RangeError('Inbox concurrency must be an integer between 1 and 8');
  }
  const inboxWaiters = new Set();
  let backgroundTasks;
  const wakeSleepingTasks = new Set();
  const workerIds = Array.from({ length: inboxConcurrency }, () => randomUUID());

  /**
   * Wait between background iterations while allowing inbox notifications or shutdown to wake the loop.
   * @param {number} milliseconds - Delay in milliseconds.
   * @param {Object} options - Options: inbox, notificationVersion.
   * @returns {Promise<void>} Resolves after the delay or an existing wakeup condition.
   */
  function pause(milliseconds, { inbox = false, notificationVersion } = {}) {
    const inboxWasNotified = inbox && inboxNotificationVersion !== notificationVersion;
    if (!running || inboxWasNotified) {
      return Promise.resolve();
    }

    return new Promise(resolve => {
      let timer;

      const wake = () => {
        clearTimeout(timer);
        wakeSleepingTasks.delete(wake);
        inboxWaiters.delete(wake);
        resolve();
      };

      wakeSleepingTasks.add(wake);
      if (inbox) {
        inboxWaiters.add(wake);
      }
      timer = setTimeout(wake, milliseconds);
    });
  }

  /**
   * Process queued jobs and retain the existing empty-queue and failure delays.
   * @param {string} workerId - Unique lease owner; the inbox enforces per-conversation ordering.
   * @returns {Promise<void>} Resolves when background processing stops.
   */
  async function inboxLoop(workerId) {
    while (running) {
      const notificationVersion = inboxNotificationVersion;

      try {
        if (await processJob(workerId)) {
          continue;
        }

        // A webhook may have queued work while the empty claim was in flight.
        await pause(pollMs, { inbox: true, notificationVersion });
      } catch (error) {
        logger.error('Inbox processing failed', safeErrorMetadata(error));
        await pause(errorDelayMs);
      }
    }
  }

  /**
   * Run monitoring polls at the configured interval without overlapping one loop's polls.
   * @returns {Promise<void>} Resolves when background processing stops.
   */
  async function monitorLoop() {
    while (running) {
      const startedAt = Date.now();

      try {
        await runMonitor();
      } catch (error) {
        logger.error('Monitoring failed', safeErrorMetadata(error));
      }

      // Count the interval from the previous poll's start, allowing for its duration.
      // Keep a one-second minimum wait when a poll exceeds the configured interval.
      const elapsedMs = Date.now() - startedAt;
      await pause(Math.max(1_000, monitorMs - elapsedMs));
    }
  }

  return {
    start() {
      if (started) {
        throw new Error('Background runtime can only start once');
      }
      started = true;
      running = true;
      backgroundTasks = Promise.all([...workerIds.map(inboxLoop), monitorLoop()]);
      logger.log('Background processing ready: Sunshine inbox and session monitor');

      return this;
    },
    notify() {
      if (!running) {
        return;
      }
      inboxNotificationVersion += 1;
      for (const wake of [...inboxWaiters]) wake();
    },
    async stop() {
      if (!running) {
        return backgroundTasks;
      }

      running = false;
      for (const wake of [...wakeSleepingTasks]) {
        wake();
      }
      await backgroundTasks;
    }
  };
}

let activeRuntime;

/**
 * Start the single inbox and monitoring runtime for this process.
 * @returns {Object} The active runtime; throws if it was already started.
 */
export function startBackgroundRuntime() {
  if (activeRuntime) {
    throw new Error('Background runtime already started');
  }
  activeRuntime = createBackgroundRuntime().start();

  return activeRuntime;
}

export function notifyInbox() {
  activeRuntime?.notify();
}

export async function stopBackgroundRuntime() {
  const runtime = activeRuntime;
  activeRuntime = undefined;
  await runtime?.stop();
}
