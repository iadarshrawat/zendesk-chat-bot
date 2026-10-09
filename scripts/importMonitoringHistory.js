import 'dotenv/config';
import sql from 'mssql';
import { sqlServerConfig } from '../src/loaders/database/sql.js';
import { databaseSchema, verifyCoreSchema } from '../src/models/schema.js';
import { createZendeskClient } from '../src/api/zendesk/client.js';
import { importLegacyMonitoring } from '../src/services/monitoring/historyImport.js';
import { safeErrorMetadata } from '../src/common/utils/timingLogger.js';

const config = sqlServerConfig();
const target = `${config.database}.${databaseSchema()}`;
const [flag, confirmedTarget] = process.argv.slice(2);
if (flag !== '--confirm-target' || confirmedTarget !== target || process.argv.length !== 4) {
  throw new Error(`History import requires --confirm-target ${target}; no database connection was made`);
}
const pool = new sql.ConnectionPool(config);
pool.on('error', error => console.error('History import database error', safeErrorMetadata(error)));
try {
  await pool.connect();
  await verifyCoreSchema(pool);
  const summary = await importLegacyMonitoring({
    client: await createZendeskClient(),
    db: pool
  });
  console.log('Monitoring history import complete', summary);
  if (summary.invalid) {
    console.error('Some legacy records failed validation; inspect their fields before removing the old object.');
    process.exitCode = 1;
  }
} catch (error) {
  console.error('Monitoring history import failed', safeErrorMetadata(error));
  process.exitCode = 1;
} finally {
  await pool.close();
}
