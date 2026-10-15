import 'dotenv/config';
import { once } from 'node:events';
import {
  createApp,
  databaseLoader,
  closeDB,
  assertRuntimeConfiguration,
  startBackgroundRuntime,
  stopBackgroundRuntime,
  safeErrorMetadata
} from './src/index.js';

const PORT = Number(process.env.PORT || 4000);
const SHUTDOWN_TIMEOUT_MS = 120_000;
let server;

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
  try {
    assertRuntimeConfiguration();
    if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
      throw new Error('PORT must be an integer between 1 and 65535');
    }
  } catch (error) {
    // Configuration errors contain setting names, never provider request objects.
    console.error('Invalid startup configuration:', error.message);
    throw error;
  }
  await databaseLoader();

  server = createApp().listen(PORT);
  // Do not start workers if the HTTP port cannot be opened.
  await once(server, 'listening');
  console.log(`HTTP server ready on port ${PORT}`);
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
      console.error('Shutdown failed', safeErrorMetadata(error));
      process.exit(1);
    }
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

start().catch(async error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Startup failed: port ${PORT} is already in use. Stop the existing server, then run npm start again.`);
  } else {
    console.error('Startup failed', safeErrorMetadata(error));
  }
  try {
    if (server?.listening) {
      await closeHttpServer(server);
    }
    await stopBackgroundRuntime();
    await closeDB();
  } catch {
    // Preserve the startup failure as the primary error.
  }
  process.exitCode = 1;
});
