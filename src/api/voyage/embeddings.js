import axios from 'axios';
import { requestOptions } from '../index.js';
import { RAG_CONFIG, assertRagConfigured } from '../../config/rag.js';
import { getRetryAfterMs, withRetry } from '../../common/utils/retry.js';
import { createRequestScheduler } from '../../common/utils/requestScheduler.js';
import { createQueryEmbeddingCache, queryEmbeddingCacheKey } from '../../common/rag/queryEmbeddingCache.js';
import { bindTrace, logStage, measureStage, measureSyncStage, startStage } from '../../common/utils/timingLogger.js';
import {
  bindResponseBudget,
  createResponseBudget,
  getResponseBudget,
  runBudgetedIO,
  runWithResponseBudget
} from '../../common/utils/responseBudget.js';

let voyageClient;
const scheduleRequest = createRequestScheduler({
  concurrency: RAG_CONFIG.voyage.requestConcurrency,
  minIntervalMs: RAG_CONFIG.voyage.requestDelayMs
});
const queryCache = createQueryEmbeddingCache({
  ttlMs: RAG_CONFIG.voyage.queryCacheTtlMs,
  maxEntries: RAG_CONFIG.voyage.queryCacheMaxEntries
});

/**
 * Reuse the configured Voyage client after checking knowledge-store configuration.
 * @returns {Object} The cached Axios embedding client.
 */
function getVoyageClient() {
  assertRagConfigured();
  if (!voyageClient) {
    voyageClient = axios.create({
      baseURL: RAG_CONFIG.voyage.baseUrl,
      headers: {
        Authorization: `Bearer ${RAG_CONFIG.voyage.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60_000
    });
  }

  return voyageClient;
}

function pauseAfterRateLimit(error, minimumDelayMs, reason) {
  const status = Number(error?.response?.status ?? error?.status);
  if (status !== 429) {
    return;
  }

  const delayMs = Math.max(minimumDelayMs, getRetryAfterMs(error) || 0);
  scheduleRequest.pauseFor(delayMs);
  logStage('voyage.cooldown', { reason, delayMs });
}

/**
 * Measure a document or query embedding request using the existing provider policy.
 * @param {Array<string>} texts - Non-empty document or query text.
 * @param {string} inputType - Existing query or document embedding mode.
 * @returns {Promise<Array<Array<number>>>} Validated embedding vectors in input order.
 */
async function requestEmbeddings(texts, inputType) {
  return measureStage('embedding.request', () => requestEmbeddingsInternal(texts, inputType), {
    operation: inputType,
    batchSize: Array.isArray(texts) ? texts.length : 0,
    model: RAG_CONFIG.voyage.model,
    dimensions: RAG_CONFIG.cosmos.vectorDimensions
  });
}

/**
 * Schedule embedding requests, honor rate limits, and validate returned vector dimensions.
 * @param {Array<string>} texts - Non-empty document or query text.
 * @param {string} inputType - Existing query or document embedding mode.
 * @returns {Promise<Array<Array<number>>>} Validated embedding vectors; rejects after exhausted retries or invalid responses.
 */
async function requestEmbeddingsInternal(texts, inputType) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }
  if (texts.some(text => typeof text !== 'string' || !text.trim())) {
    throw new Error('Voyage embedding input must contain non-empty strings');
  }

  const response = await withRetry(
    attempt => {
      const scheduled = startStage('voyage.scheduler_wait', {
        attempt: attempt + 1,
        ...scheduleRequest.getStats?.()
      });

      return scheduleRequest(
        bindTrace(
          bindResponseBudget(async () => {
            scheduled.end({ ...scheduleRequest.getStats?.() });

            return measureStage(
              'voyage.http',
              async () => {
                try {
                  const httpResponse = await runBudgetedIO(
                    ({ signal, timeoutMs }) =>
                      getVoyageClient().post(
                        '/embeddings',
                        {
                          input: texts,
                          model: RAG_CONFIG.voyage.model,
                          input_type: inputType,
                          output_dimension: RAG_CONFIG.cosmos.vectorDimensions,
                          output_dtype: 'float',
                          truncation: false
                        },
                        ...requestOptions(signal, timeoutMs)
                      ),
                    60_000
                  );
                  logStage('voyage.response', {
                    httpStatus: httpResponse.status,
                    inputTokens: Number(httpResponse.data?.usage?.total_tokens) || 0
                  });

                  return httpResponse;
                } catch (error) {
                  // Also pause on a final 429 (even when retries are disabled/exhausted).
                  pauseAfterRateLimit(error, RAG_CONFIG.voyage.retryBaseDelayMs || 0, 'http_429');
                  throw error;
                }
              },
              {
                attempt: attempt + 1,
                model: RAG_CONFIG.voyage.model,
                timeoutMs: 60_000,
                batchSize: texts.length,
                inputChars: texts.reduce((sum, text) => sum + text.length, 0)
              }
            );
          })
        ),
        { signal: getResponseBudget()?.signal }
      );
    },
    {
      operationName: 'voyage',
      maxRetries: RAG_CONFIG.voyage.maxRetries,
      baseDelayMs: RAG_CONFIG.voyage.retryBaseDelayMs,
      maxDelayMs: RAG_CONFIG.voyage.retryMaxDelayMs,
      onRetry: ({ error, attempt, delayMs, maxRetries }) => {
        pauseAfterRateLimit(error, delayMs, 'retry_after');
        console.warn(`Voyage request rate-limited or unavailable; retry ${attempt}/${maxRetries} in ${delayMs}ms.`);
      }
    }
  );

  return measureSyncStage(
    'voyage.response_validate',
    () => {
      const ordered = [...(response.data?.data || [])].sort((left, right) => left.index - right.index);
      const embeddings = ordered.map(item => item.embedding);
      const hasInvalidEmbedding = embeddings.some(
        embedding =>
          !Array.isArray(embedding) ||
          embedding.length !== RAG_CONFIG.cosmos.vectorDimensions ||
          embedding.some(value => !Number.isFinite(value))
      );

      if (embeddings.length !== texts.length || hasInvalidEmbedding) {
        throw new Error('Voyage returned an unexpected embedding response');
      }

      return embeddings;
    },
    {
      batchSize: texts.length,
      dimensions: RAG_CONFIG.cosmos.vectorDimensions
    }
  );
}

/**
 * Embed document text in configured batches for knowledge ingestion.
 * @param {Array<string>} texts - Non-empty document or query text.
 * @returns {Promise<Array<Array<number>>>} One embedding vector per input text, in input order.
 */
export async function embedDocuments(texts) {
  const span = startStage('embedding.documents', { batchSize: texts.length });
  try {
    const embeddings = [];
    for (let index = 0; index < texts.length; index += RAG_CONFIG.voyage.batchSize) {
      const batch = texts.slice(index, index + RAG_CONFIG.voyage.batchSize);
      embeddings.push(...(await requestEmbeddings(batch, 'document')));
    }

    return embeddings;
  } catch (error) {
    span.fail(error);
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Embed a query through the shared cache without tying its loader to one customer deadline.
 * @param {string} text - Text to normalize or inspect.
 * @returns {Promise<Array<number>>} A validated query vector, returned as a copy from the cache.
 */
export async function embedQuery(text) {
  const span = startStage('embedding.query', {
    model: RAG_CONFIG.voyage.model,
    dimensions: RAG_CONFIG.cosmos.vectorDimensions,
    inputChars: typeof text === 'string' ? text.length : 0
  });
  try {
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('Voyage embedding input must contain non-empty strings');
    }
    const key = queryEmbeddingCacheKey({
      baseUrl: RAG_CONFIG.voyage.baseUrl,
      model: RAG_CONFIG.voyage.model,
      dimensions: RAG_CONFIG.cosmos.vectorDimensions,
      text
    });
    let outcome;
    const live = getResponseBudget();
    const embedding = await runBudgetedIO(() =>
      queryCache.getOrCreate(
        key,
        async () => {
          // A shared cache miss is not owned by its first customer. Cancellation
          // detaches that waiter; another customer's same-key request can still
          // finish. The shared loader itself has a short, independent live limit.
          const shared = live ? createResponseBudget({ timeoutMs: 5000, reserveMs: 0 }) : null;
          try {
            return await runWithResponseBudget(shared, async () => {
              const [vector] = await requestEmbeddings([text], 'query');

              return vector;
            });
          } finally {
            shared?.dispose();
          }
        },
        result => {
          outcome = result;
          logStage('embedding.cache', {
            outcome: result,
            keyHash: key.slice(0, 12),
            ttlMs: RAG_CONFIG.voyage.queryCacheTtlMs,
            maxEntries: RAG_CONFIG.voyage.queryCacheMaxEntries,
            ...queryCache.getStats()
          });
        }
      )
    );

    span.end({ outcome, keyHash: key.slice(0, 12), ...queryCache.getStats() });

    return embedding;
  } catch (error) {
    span.fail(error);
    throw error;
  }
}
