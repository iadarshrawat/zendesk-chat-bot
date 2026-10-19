import 'dotenv/config';
import sql from 'mssql';
import { sqlServerConfig } from '../../src/loaders/database/sql/index.js';
import { databaseTarget, verifyCoreSchema } from '../../src/models/schema/index.js';
import { createZendeskClient } from '../../src/api/zendesk/client/index.js';
import { backfillMonitoringIntents } from './backfill/index.js';
import { safeErrorMetadata } from '../../src/common/utils/timingLogger/index.js';

const config = sqlServerConfig();
const target = databaseTarget(config.database);
const [flag, confirmedTarget, mode] = process.argv.slice(2);
const allSessions = mode === '--all-sessions';
if (flag !== '--confirm-target' || confirmedTarget !== target || process.argv.length !== (allSessions ? 5 : 4)) {
  throw new Error(`Intent backfill requires --confirm-target ${target}; no database connection was made`);
}

const pool = new sql.ConnectionPool(config);
pool.on('error', error => console.error('Intent backfill database error', safeErrorMetadata(error)));
try {
  await pool.connect();
  await verifyCoreSchema(pool);
  const summary = await backfillMonitoringIntents({
    db: pool,
    client: await createZendeskClient(),
    allSessions,
    onProgress: allSessions ? counts => console.log('Intent migration progress', counts) : undefined
  });
  console.log('Monitoring intent backfill complete', summary);
  if (summary.failed) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error('Monitoring intent backfill failed', safeErrorMetadata(error));
  process.exitCode = 1;
} finally {
  await pool.close();
}
