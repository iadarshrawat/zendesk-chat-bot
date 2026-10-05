import dotenv from "dotenv";

dotenv.config();

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function booleanValue(value, fallback) {
  if (value == null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

function finiteNumber(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function effortLevel(value, fallback) {
  return ["low", "medium", "high"].includes(value) ? value : fallback;
}

const responseTargetMs = Math.min(
  60_000,
  Math.max(5_000, positiveInteger(process.env.BOT_RESPONSE_TARGET_MS, 15_000)),
);
const configuredHardTimeoutMs = Math.min(
  120_000,
  Math.max(5_000, positiveInteger(process.env.BOT_RESPONSE_HARD_TIMEOUT_MS, 45_000)),
);
const responseHardTimeoutMs = Math.max(responseTargetMs, configuredHardTimeoutMs);

export const RAG_CONFIG = {
  cosmos: {
    endpoint: process.env.COSMOS_ENDPOINT?.trim() || "",
    key: process.env.COSMOS_KEY?.trim() || "",
    databaseId: process.env.COSMOS_DATABASE_ID?.trim() || "zendesk-rag",
    containerId: process.env.COSMOS_CONTAINER_ID?.trim() || "knowledge",
    vectorDimensions: positiveInteger(process.env.RAG_VECTOR_DIMENSIONS, 1024),
    vectorIndexType: process.env.COSMOS_VECTOR_INDEX_TYPE?.trim() || "quantizedFlat",
    writeConcurrency: positiveInteger(process.env.COSMOS_WRITE_CONCURRENCY, 4),
    maxRetries: nonNegativeInteger(process.env.COSMOS_MAX_RETRIES, 8),
    retryBaseDelayMs: nonNegativeInteger(process.env.COSMOS_RETRY_BASE_DELAY_MS, 500),
    retryMaxDelayMs: nonNegativeInteger(process.env.COSMOS_RETRY_MAX_DELAY_MS, 10_000),
  },
  voyage: {
    apiKey: process.env.VOYAGE_API_KEY?.trim() || "",
    baseUrl: process.env.VOYAGE_BASE_URL?.trim() || "https://api.voyageai.com/v1",
    model: process.env.VOYAGE_EMBEDDING_MODEL?.trim() || "voyage-4-lite",
    batchSize: positiveInteger(process.env.VOYAGE_BATCH_SIZE, 16),
    maxRetries: nonNegativeInteger(process.env.VOYAGE_MAX_RETRIES, 8),
    retryBaseDelayMs: nonNegativeInteger(process.env.VOYAGE_RETRY_BASE_DELAY_MS, 1_000),
    retryMaxDelayMs: nonNegativeInteger(process.env.VOYAGE_RETRY_MAX_DELAY_MS, 30_000),
    requestDelayMs: nonNegativeInteger(process.env.VOYAGE_REQUEST_DELAY_MS, 1_000),
    requestConcurrency: Math.min(8, positiveInteger(process.env.VOYAGE_REQUEST_CONCURRENCY, 2)),
    queryCacheTtlMs: nonNegativeInteger(process.env.RAG_EMBEDDING_CACHE_TTL_MS, 3_600_000),
    queryCacheMaxEntries: Math.min(
      5_000,
      nonNegativeInteger(process.env.RAG_EMBEDDING_CACHE_MAX_ENTRIES, 500),
    ),
  },
  retrieval: {
    candidateCount: Math.min(100, positiveInteger(process.env.RAG_CANDIDATE_COUNT, 24)),
    finalChunkCount: Math.min(24, positiveInteger(process.env.RAG_FINAL_CHUNK_COUNT, 10)),
    maxChunksPerSection: positiveInteger(process.env.RAG_MAX_CHUNKS_PER_SECTION, 4),
    maxChunksPerProduct: positiveInteger(process.env.RAG_MAX_CHUNKS_PER_PRODUCT, 3),
    maxStructuredResults: positiveInteger(process.env.RAG_MAX_STRUCTURED_RESULTS, 100),
    maxVectorDistance: finiteNumber(process.env.RAG_MAX_VECTOR_DISTANCE, 0.55),
    strictDistanceCutoff: booleanValue(process.env.RAG_STRICT_DISTANCE_CUTOFF, false),
    queryPlanningEnabled: booleanValue(process.env.RAG_QUERY_PLANNING_ENABLED, true),
    plannerTimeoutMs: positiveInteger(process.env.RAG_PLANNER_TIMEOUT_MS, 20_000),
    answerTimeoutMs: positiveInteger(process.env.RAG_ANSWER_TIMEOUT_MS, 60_000),
    answerMaxTokens: Math.min(8192, positiveInteger(process.env.RAG_ANSWER_MAX_TOKENS, 4096)),
    recoveryEnabled: booleanValue(process.env.RAG_RECOVERY_ENABLED, true),
    maxRecoveryQueries: Math.min(3, positiveInteger(process.env.RAG_MAX_RECOVERY_QUERIES, 3)),
    catalogCacheMs: nonNegativeInteger(process.env.RAG_CATALOG_CACHE_MS, 60_000),
    revisionCacheMs: nonNegativeInteger(process.env.RAG_REVISION_CACHE_MS, 30_000),
    snapshotCleanupGraceMs: nonNegativeInteger(
      process.env.RAG_SNAPSHOT_CLEANUP_GRACE_MS,
      35_000,
    ),
    debug: booleanValue(process.env.RAG_DEBUG, false),
    includeSources: booleanValue(process.env.RAG_INCLUDE_SOURCES, false),
    compactContext: booleanValue(process.env.RAG_COMPACT_CONTEXT, true),
    citationRepairEnabled: booleanValue(process.env.RAG_CITATION_REPAIR_ENABLED, true),
    citationRepairTimeoutMs: positiveInteger(
      process.env.RAG_CITATION_REPAIR_TIMEOUT_MS,
      10_000,
    ),
    citationRepairMaxTokens: Math.min(
      2_048,
      positiveInteger(process.env.RAG_CITATION_REPAIR_MAX_TOKENS, 768),
    ),
  },
  conversation: {
    responseTargetMs,
    responseHardTimeoutMs,
    deliveryReserveMs: Math.min(
      4_000,
      positiveInteger(process.env.BOT_DELIVERY_RESERVE_MS, 2_500),
    ),
    classifierTimeoutMs: positiveInteger(process.env.BOT_CLASSIFIER_TIMEOUT_MS, 2500),
    plannerStageTimeoutMs: positiveInteger(process.env.BOT_PLANNER_STAGE_TIMEOUT_MS, 6000),
    historyTimeoutMs: positiveInteger(process.env.BOT_HISTORY_TIMEOUT_MS, 1500),
    stateTimeoutMs: positiveInteger(process.env.BOT_STATE_TIMEOUT_MS, 2500),
    stateSaveTimeoutMs: positiveInteger(process.env.BOT_STATE_SAVE_TIMEOUT_MS, 500),
    typingTimeoutMs: positiveInteger(process.env.BOT_TYPING_TIMEOUT_MS, 1250),
    typingStopTimeoutMs: positiveInteger(process.env.BOT_TYPING_STOP_TIMEOUT_MS, 750),
    sendTimeoutMs: positiveInteger(process.env.BOT_SEND_TIMEOUT_MS, 1500),
    answerEffort: effortLevel(process.env.BOT_ANSWER_EFFORT, "medium"),
    plannerEffort: effortLevel(process.env.BOT_PLANNER_EFFORT, "low"),
    structuredAnswers: booleanValue(process.env.BOT_STRUCTURED_ANSWERS, true),
    historyMessages: Math.min(60, positiveInteger(process.env.BOT_HISTORY_MESSAGES, 24)),
  },
  chunking: {
    wordsPerChunk: positiveInteger(process.env.RAG_CHUNK_WORDS, 380),
    overlapWords: nonNegativeInteger(process.env.RAG_CHUNK_OVERLAP_WORDS, 60),
  },
};

export function getMissingRagConfiguration() {
  const required = {
    COSMOS_ENDPOINT: RAG_CONFIG.cosmos.endpoint,
    COSMOS_KEY: RAG_CONFIG.cosmos.key,
    VOYAGE_API_KEY: RAG_CONFIG.voyage.apiKey,
  };

  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

export function isRagConfigured() {
  return getMissingRagConfiguration().length === 0;
}

export function assertRagConfigured() {
  const missing = getMissingRagConfiguration();
  if (missing.length > 0) {
    throw new Error(`RAG configuration is missing: ${missing.join(", ")}`);
  }
}
