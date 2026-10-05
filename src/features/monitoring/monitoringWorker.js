import { getPool } from "../../config/sql.js";
import { runReport } from "./monitoringJob.js";

const MONITOR_LOCK_NAME = "zendesk-bot-monitor-v1";

/** Only one app instance may run the monitor for this SQL Server database. */
export async function runExclusiveMonitor({
  pool = getPool(),
  report = runReport,
} = {}) {
  // A transaction pins one SQL Server connection while the report uses other
  // pool connections. The application lock is released by the rollback below.
  const transaction = pool.transaction();
  let began = false;

  try {
    await transaction.begin();
    began = true;

    const lock = await transaction.request()
      .input("resource", MONITOR_LOCK_NAME)
      .query(`DECLARE @lockResult int;
        EXEC @lockResult = sys.sp_getapplock
          @Resource = @resource,
          @LockMode = 'Exclusive',
          @LockOwner = 'Transaction',
          @LockTimeout = 0;
        SELECT @lockResult AS acquired;`);
    const acquired = lock.recordset[0]?.acquired;
    if (acquired === -1) {
      return { skipped: true };
    }
    if (!Number.isInteger(acquired) || acquired < 0) {
      throw new Error(`SQL Server monitor lock failed (${acquired ?? "unknown"})`);
    }

    const result = await report();
    if (!result.success) {
      throw new Error(result.error || "Monitoring run failed");
    }
    return result;
  } finally {
    if (began) {
      try {
        await transaction.rollback();
      } catch (error) {
        // A broken connection releases its lock when SQL Server closes it.
        console.error("Monitor lock cleanup failed:", error.code || error.message);
      }
    }
  }
}
