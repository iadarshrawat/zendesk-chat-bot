import sql from 'mssql';
import { delay } from '../../common/utils/index.js';
import dotenv from 'dotenv';
import { logStage, measureStage, safeErrorMetadata, startStage } from '../../common/utils/timingLogger.js';
import { databaseSchema, verifyCoreSchema } from '../../models/schema.js';

dotenv.config();

let pool;

/**
 * Read an integer environment setting and validate it against the existing allowed range.
 * @param {Object} environment - Environment settings; defaults to process.env.
 * @param {string} name - Setting or field name.
 * @param {*} fallback - Existing default when the input is missing.
 * @param {number} minimum - Minimum permitted setting value.
 * @param {number} maximum - Maximum permitted setting value.
 * @returns {number} The configured integer or default; throws for an invalid value.
 */
function integerSetting(environment, name, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const rawValue = environment[name];
  if (rawValue == null || rawValue === '') {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    const range = maximum === Number.MAX_SAFE_INTEGER ? `greater than or equal to ${minimum}` : `between ${minimum} and ${maximum}`;
    throw new Error(`${name} must be an integer ${range}`);
  }

  return value;
}

/**
 * Read a SQL boolean setting from its supported environment-variable values.
 * @param {Object} environment - Environment values to inspect.
 * @param {string} name - Setting name.
 * @param {boolean} fallback - Default when the setting is absent.
 * @returns {boolean} The parsed setting; throws for an invalid value.
 */
function booleanSetting(environment, name, fallback) {
  const rawValue = environment[name];
  if (rawValue == null || rawValue.trim() === '') {
    return fallback;
  }

  const value = rawValue.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(value)) {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}

function requiredSetting(environment, name) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

/**
 * Build and validate SQL connection, encryption, timeout, and pool settings from DB variables.
 * @param {Object} environment - Environment settings; defaults to process.env.
 * @returns {Object} The node-mssql connection configuration without opening a connection.
 */
export function sqlServerConfig(environment = process.env) {
  const maxConnections = integerSetting(environment, 'DB_POOL_CONNECTION_LIMIT', 10, 2);
  const minConnections = integerSetting(environment, 'DB_POOL_MIN_CONNECTIONS', 0);

  if (minConnections > maxConnections) {
    throw new Error('DB_POOL_MIN_CONNECTIONS cannot exceed DB_POOL_CONNECTION_LIMIT');
  }

  // Validate this alongside the connection settings so invalid names fail at startup.
  databaseSchema(environment.DB_SCHEMA ?? '');

  return {
    server: requiredSetting(environment, 'DB_HOST'),
    port: integerSetting(environment, 'DB_PORT', 1433, 1, 65_535),
    user: requiredSetting(environment, 'DB_USER'),
    password: environment.DB_PASSWORD ?? '',
    database: requiredSetting(environment, 'DB_NAME'),
    connectionTimeout: integerSetting(environment, 'DB_CONNECT_TIMEOUT_MS', 5_000, 1),
    requestTimeout: integerSetting(environment, 'DB_REQUEST_TIMEOUT_MS', 30_000, 1),
    pool: {
      max: maxConnections,
      min: minConnections,
      idleTimeoutMillis: integerSetting(environment, 'DB_POOL_IDLE_TIMEOUT_MS', 60_000, 1)
    },
    options: {
      useUTC: true,
      encrypt: booleanSetting(environment, 'DB_ENCRYPT', true),
      trustServerCertificate: booleanSetting(environment, 'DB_TRUST_SERVER_CERTIFICATE', false),
      abortTransactionOnError: true
    }
  };
}

/**
 * Return the initialized shared SQL connection pool.
 * @returns {Object} The pool; throws if startup has not initialized it.
 */
export function getPool() {
  if (!pool) {
    throw new Error('Microsoft SQL Server has not been initialized');
  }

  return pool;
}

/**
 * Wrap a schema-validation failure with the existing operator guidance.
 * @param {Error} error - Original SQL schema failure.
 * @returns {Error} The startup error preserving its cause and code.
 */
function schemaStartupError(error) {
  const failure = new Error(
    `SQL Server schema check failed in DB_NAME=${process.env.DB_NAME || '(unset)'}. ` +
      'Only bot_conversation_state, bot_monitor_sessions and bot_monitor_evaluations are supported. ' +
      'Review migrations/001_core.sql and 002_monitor_evaluations.sql, then run npm run db:migrate explicitly if any is missing; ' +
      'normal startup never creates or changes tables.',
    { cause: error }
  );
  failure.code = error?.code;

  return failure;
}

/**
 * Connect SQL with bounded startup retries and require the existing application schema.
 * @returns {Promise<void>} Resolves once the shared pool is ready; otherwise rejects without changing tables.
 */
export async function connectDB() {
  const startup = startStage('sqlserver.initialize');
  let config;

  try {
    config = sqlServerConfig();
  } catch (error) {
    startup.fail(error);
    throw error;
  }

  const maxAttempts = integerSetting(process.env, 'DB_STARTUP_MAX_ATTEMPTS', 5, 1);
  const baseDelayMs = integerSetting(process.env, 'DB_STARTUP_RETRY_BASE_MS', 1_000);
  const maxDelayMs = Math.max(baseDelayMs, integerSetting(process.env, 'DB_STARTUP_RETRY_MAX_MS', 5_000));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let candidatePool;
    let connected = false;
    const retryMetadata = { attempt, maxRetries: maxAttempts - 1 };
    const attemptSpan = startStage('sqlserver.startup_attempt', retryMetadata);

    try {
      candidatePool = new sql.ConnectionPool(config);
      candidatePool.on('error', error => {
        logStage('sqlserver.pool_error', safeErrorMetadata(error));
      });
      await measureStage('sqlserver.startup_connection', () => candidatePool.connect(), retryMetadata);
      connected = true;

      await measureStage('sqlserver.schema', () => verifyCoreSchema(candidatePool, process.env.DB_SCHEMA));

      pool = candidatePool;
      console.log('✅ Microsoft SQL Server connected');
      attemptSpan.end();
      startup.end();

      return;
    } catch (error) {
      attemptSpan.fail(error);

      try {
        await candidatePool?.close?.();
      } catch {
        // Preserve the startup error; cleanup is best effort.
      }

      if (connected || attempt >= maxAttempts) {
        const failure = connected ? schemaStartupError(error) : error;
        startup.fail(failure);
        console.error('❌ SQL Server startup error:', failure);
        throw failure;
      }

      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      logStage('sqlserver.startup_retry', {
        ...retryMetadata,
        delayMs,
        ...safeErrorMetadata(error)
      });
      console.warn(`⚠️ SQL Server connection failed; retrying in ${delayMs}ms`, {
        attempt,
        maxAttempts,
        errorCode: error?.code || 'UNKNOWN'
      });
      await delay(delayMs);
    }
  }
}

/**
 * Detach and close the shared SQL pool during shutdown.
 * @returns {Promise<void>} Resolves when the initialized pool closes; does nothing if no pool exists.
 */
export async function closeDB() {
  if (!pool) {
    return;
  }

  const closingPool = pool;
  pool = undefined;
  await closingPool.close();
}

/**
 * Check SQL connectivity without reading or changing an application table.
 * @param {Object} db - Initialized SQL connection pool; defaults to the shared pool.
 * @returns {Promise<Object>} The SELECT 1 result; rejects on a connection failure.
 */
export function checkDatabaseConnection(db = getPool()) {
  return db.request().query('SELECT 1 AS ok');
}
