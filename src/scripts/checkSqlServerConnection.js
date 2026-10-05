import "dotenv/config";
import sql from "mssql";
import { sqlServerConfig } from "../config/sql.js";

let pool;
try {
  // Keep this check independent of startup's schema verification.
  pool = new sql.ConnectionPool(sqlServerConfig());
  pool.on("error", (error) => {
    console.error(`SQL Server pool error (${error.code || "UNKNOWN"}).`);
  });
  await pool.connect();
  await pool.request().query("SELECT 1 AS ok");
  console.log("SQL Server connection succeeded. No table was read or changed.");
} catch (error) {
  console.error(`SQL Server connectivity check failed (${error.code || "UNKNOWN"}).`);
  process.exitCode = 1;
} finally {
  try {
    await pool?.close();
  } catch {
    // Preserve the connection result if the socket was already closed.
  }
}
