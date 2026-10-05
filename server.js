import "dotenv/config";
import { createApp } from "./src/app.js";
import { connectDB, closeDB } from "./src/config/sql.js";
import { assertRuntimeConfiguration } from "./src/config/runtime.js";
import { verifyKnowledgeStore } from "./src/config/cosmos.js";
import { startBackgroundRuntime, stopBackgroundRuntime } from "./src/runtime/background.js";

const PORT = Number(process.env.PORT || 4000);
const SHUTDOWN_TIMEOUT_MS = 120_000;

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function start() {
  assertRuntimeConfiguration();
  await connectDB();
  await verifyKnowledgeStore();

  const server = createApp().listen(PORT, () => console.log("HTTP server ready"));
  startBackgroundRuntime();

  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      await Promise.all([closeHttpServer(server), stopBackgroundRuntime()]);
      await closeDB();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      console.error("Shutdown failed", error);
      process.exit(1);
    }
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

start().catch(async (error) => {
  console.error("Startup failed", error);
  try {
    await closeDB();
  } catch {
    // Preserve the startup failure as the primary error.
  }
  process.exitCode = 1;
});
