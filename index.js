import 'dotenv/config';
import { createApp, databaseLoader, closeDB } from './src/loaders/index.js';
import { assertRuntimeConfiguration } from './src/config/runtime.js';
import { startBackgroundRuntime, stopBackgroundRuntime } from './src/common/cron/index.js';

const PORT = Number(process.env.PORT || 4000);
const SHUTDOWN_TIMEOUT_MS = 120_000;

/**
 * Stop accepting HTTP requests and wait for active requests to finish.
 * @param {Object} server - Running Node HTTP server.
 * @returns {Promise<void>} Resolves when the HTTP server closes.
 */
function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);

        return;
      }
      resolve();
    });
  });
}

/**
 * Validate configuration and stores before starting HTTP and background processing.
 * @returns {Promise<void>} Resolves after startup; rejects if initialization fails.
 */
async function start() {
  assertRuntimeConfiguration();
  await databaseLoader();

  const server = createApp().listen(PORT, () => console.log('HTTP server ready'));
  startBackgroundRuntime();

  let shuttingDown = false;

  /**
   * Drain HTTP and background work, then close SQL connections within the shutdown limit.
   * @returns {Promise<void>} Exits after graceful shutdown or a cleanup failure.
   */
  async function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      await Promise.all([closeHttpServer(server), stopBackgroundRuntime()]);
      await closeDB();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      console.error('Shutdown failed', error);
      process.exit(1);
    }
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

start().catch(async error => {
  console.error('Startup failed', error);
  try {
    await closeDB();
  } catch {
    // Preserve the startup failure as the primary error.
  }
  process.exitCode = 1;
});
