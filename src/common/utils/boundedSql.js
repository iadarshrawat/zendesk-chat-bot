import { runWithDeadline } from './responseBudget.js';

const TRANSPORT_ERRORS = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKET', 'ECONNCLOSED', 'ENOTOPEN', 'ETIMEOUT']);
const UNSAFE_READ_PATTERN = new RegExp(
  ';|:=|\\bINTO\\b|\\b(?:UPDLOCK|XLOCK|HOLDLOCK|TABLOCK|TABLOCKX)\\b' + '|\\bNEXT\\s+VALUE\\s+FOR\\b',
  'i'
);

// Retry is explicit and limited to trusted, non-locking SELECTs. Mutations,
// locking reads and ambiguous writes must never be replayed automatically.
function canRetryRead(sql) {
  const isSelect = /^\s*SELECT\b/i.test(sql);
  const hasUnsafeClause = UNSAFE_READ_PATTERN.test(sql);

  return isSelect && !hasUnsafeClause;
}

/**
 * Bind SQL parameters and execute within the caller's deadline, retrying only permitted reads.
 * @param {Object} pool - SQL connection pool.
 * @param {string} sql - Parameterized SQL statement to execute.
 * @param {Object} parameters - Named SQL parameter values.
 * @param {Object} options - Options: timeoutMs, signal, retryRead, onRetry, parameterTypes, stage.
 * @returns {Promise<Object>} The SQL driver's result; rejects with the original or deadline error.
 */
export async function executeBoundedSql(
  pool,
  sql,
  parameters,
  { timeoutMs, signal, retryRead = false, onRetry, parameterTypes = {}, stage = 'mssql.operation' } = {}
) {
  if (parameters != null && (typeof parameters !== 'object' || Array.isArray(parameters))) {
    throw new TypeError('SQL parameters must be an object keyed by parameter name');
  }

  const maxAttempts = retryRead && canRetryRead(sql) ? 2 : 1;

  return runWithDeadline(
    async ({ signal: child }) => {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (child?.aborted) {
          throw child.reason;
        }

        const request = pool.request();
        for (const [name, value] of Object.entries(parameters || {})) {
          const type = parameterTypes[name];
          if (type) {
            request.input(name, type, value);
          } else {
            request.input(name, value);
          }
        }

        const cancel = () => {
          try {
            request.cancel();
          } catch {
            // Keep the query or cancellation error as the primary failure.
          }
        };

        try {
          child?.addEventListener('abort', cancel, { once: true });
          if (child?.aborted) {
            throw child.reason;
          }
          const result = await request.query(sql);
          if (child?.aborted) {
            throw child.reason;
          }

          return result;
        } catch (error) {
          if (child?.aborted) {
            throw child.reason;
          }
          if (attempt >= maxAttempts || !TRANSPORT_ERRORS.has(error?.code)) {
            throw error;
          }

          try {
            onRetry?.({ error, attempt, maxRetries: 1 });
          } catch {
            // Retry instrumentation must not replace the database error.
          }
        } finally {
          child?.removeEventListener('abort', cancel);
        }
      }
    },
    { timeoutMs, signal, stage }
  );
}
