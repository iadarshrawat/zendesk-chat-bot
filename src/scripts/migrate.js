import "dotenv/config";
import sql from "mssql";
import { sqlServerConfig } from "../config/sql.js";
import { databaseSchema, initializeCoreSchema } from "../config/schema.js";
import { safeErrorMetadata } from "../shared/timingLogger.js";

const config = sqlServerConfig();
const target = `${config.database}.${databaseSchema()}`;
const [flag, confirmedTarget] = process.argv.slice(2);
if (flag !== "--confirm-target" || confirmedTarget !== target || process.argv.length !== 4) {
  throw new Error(`Migration requires --confirm-target ${target}; no database connection was made`);
}

const pool = new sql.ConnectionPool(config);
pool.on("error", (error) => {
  console.error("SQL Server migration pool error", safeErrorMetadata(error));
});

try {
  await pool.connect();
  await initializeCoreSchema(pool, process.env.DB_SCHEMA);
  console.log("SQL Server core-table migration complete");
} catch (error) {
  console.error("SQL Server migration failed", safeErrorMetadata(error));
  process.exitCode = 1;
} finally {
  await pool.close();
}
