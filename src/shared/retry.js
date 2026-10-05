import { logStage, startStage, safeErrorMetadata } from "./timingLogger.js";
import { checkResponseBudget, waitWithinBudget } from "./responseBudget.js";

const DEFAULT_RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

export function wait(milliseconds) {
  const delay = Math.max(0, Number(milliseconds) || 0);
  return waitWithinBudget(delay);
}

function parseRetryAfterHeader(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);

  const date = Date.parse(String(value));
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - now);
}

export function getRetryAfterMs(error) {
  const directValue =
    error?.retryAfterInMs ??
    error?.retryAfterInMilliseconds ??
    error?.response?.data?.retryAfterInMs;
  if (Number.isFinite(Number(directValue)) && Number(directValue) >= 0) {
    return Number(directValue);
  }

  const azureHeader = error?.headers?.["x-ms-retry-after-ms"];
  if (Number.isFinite(Number(azureHeader)) && Number(azureHeader) >= 0) {
    return Number(azureHeader);
  }

  return parseRetryAfterHeader(
    error?.response?.headers?.["retry-after"] ??
      error?.headers?.["retry-after"],
  );
}

export function isRetryableError(error, retryableStatusCodes = DEFAULT_RETRYABLE_STATUS_CODES) {
  const status = Number(
    error?.response?.status ?? error?.statusCode ?? error?.status ?? error?.code,
  );
  if (retryableStatusCodes.has(status)) return true;
  return RETRYABLE_NETWORK_CODES.has(error?.code);
}

export async function withRetry(operation, options = {}) {
  const maxRetries = Math.max(0, Number(options.maxRetries) || 0);
  const baseDelayMs = Math.max(0, Number(options.baseDelayMs) || 0);
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs) || baseDelayMs);

  for (let attempt = 0; ; attempt += 1) {
    checkResponseBudget();
    try {
      return await operation(attempt);
    } catch (error) {
      checkResponseBudget();
      if (attempt >= maxRetries || !isRetryableError(error)) {
        logStage("retry.exhausted_or_not_retryable", {
          operation: options.operationName,
          attempt: attempt + 1,
          maxRetries,
          ...safeErrorMetadata(error),
        });
        throw error;
      }

      const retryAfterMs = getRetryAfterMs(error);
      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
      const delayMs = Math.min(
        maxDelayMs,
        retryAfterMs == null ? exponentialDelay : Math.max(exponentialDelay, retryAfterMs),
      );
      options.onRetry?.({ error, attempt: attempt + 1, delayMs, maxRetries });
      const backoff = startStage("retry.backoff", {
        operation: options.operationName,
        attempt: attempt + 1,
        delayMs,
        maxRetries,
        ...safeErrorMetadata(error),
      });

      try {
        await wait(delayMs);
        backoff.end();
      } catch (cancelled) {
        backoff.fail(cancelled);
        throw cancelled;
      }
    }
  }
}
