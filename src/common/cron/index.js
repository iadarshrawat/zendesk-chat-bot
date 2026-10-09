import { randomUUID } from 'node:crypto';
import { processOneInboxJob } from '../../services/messaging/worker.js';
import { runExclusiveMonitor } from '../../services/monitoring/worker.js';

/**
 * Create inbox and monitoring loops with the existing wakeup, polling, and shutdown rules.
 * @param {Object} options - Options: processJob, runMonitor, pollMs, errorDelayMs, monitorMs, logger.
 * @returns {Object} start, notify, and stop operations for one background runtime.
 */
export function createBackgroundRuntime({
  processJob = processOneInboxJob,
  runMonitor = runExclusiveMonitor,
  pollMs = 750,
  errorDelayMs = 5_000,
  monitorMs = 300_000,
  logger = console
} = {}) {
  let running = false;
  let started = false;
  let inboxNotificationVersion = 0;
  let inboxWaiter;
  let backgroundTasks;
  const wakeSleepingTasks = new Set();
  const workerId = randomUUID();

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
        if (inboxWaiter === wake) {
          inboxWaiter = undefined;
        }
        resolve();
      };

      wakeSleepingTasks.add(wake);
      if (inbox) {
        inboxWaiter = wake;
      }
      timer = setTimeout(wake, milliseconds);
    });
  }

  /**
   * Process queued jobs and retain the existing empty-queue and failure delays.
   * @returns {Promise<void>} Resolves when background processing stops.
   */
  async function inboxLoop() {
    while (running) {
      const notificationVersion = inboxNotificationVersion;

      try {
        if (await processJob(workerId)) {
          continue;
        }

        // A webhook may have queued work while the empty claim was in flight.
        await pause(pollMs, { inbox: true, notificationVersion });
      } catch (error) {
        logger.error('Inbox processing failed', error);
        await pause(errorDelayMs);
      }
    }
  }

  /**
   * Run monitoring polls roughly five minutes apart without overlapping one loop's polls.
   * @returns {Promise<void>} Resolves when background processing stops.
   */
  async function monitorLoop() {
    while (running) {
      const startedAt = Date.now();

      try {
        await runMonitor();
      } catch (error) {
        logger.error('Monitoring failed', error);
      }

      // Start polls roughly five minutes apart, rather than five minutes
      // after the previous poll finishes. Avoid a tight loop on slow polls.
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
      backgroundTasks = Promise.all([inboxLoop(), monitorLoop()]);
      logger.log('Background processing ready: Sunshine inbox and session monitor');

      return this;
    },
    notify() {
      if (!running) {
        return;
      }
      inboxNotificationVersion += 1;
      inboxWaiter?.();
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
