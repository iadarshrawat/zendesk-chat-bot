import { ensureKnowledgeContainer } from "../../config/cosmos.js";
import { RAG_CONFIG } from "../../config/rag.js";
import {
  buildStructuredProductQuery as buildProductQuery,
  buildVectorQuery,
  buildCatalogSummaryQuery,
  buildManufacturerSummaryQuery,
} from "./knowledgeQueries.js";
import { withRetry } from "../../shared/retry.js";
import { logStage, measureStage, startStage } from "../../shared/timingLogger.js";
import { runBudgetedIO, checkResponseBudget } from "../../shared/responseBudget.js";

const catalogSummaryCache = new Map();
const activeRevisionCache = new Map();
const ACTIVE_REVISION_CACHE_MS = Number.isFinite(RAG_CONFIG.retrieval.revisionCacheMs)
  ? RAG_CONFIG.retrieval.revisionCacheMs
  : 30_000;
const REVISION_RECORD_ID = "active-knowledge-revision";

function isNotFound(error) {
  return error?.code === 404 || error?.statusCode === 404;
}

function runCosmosOperation(operation, label) {
  const operationName = label.split(" for ")[0];
  return measureStage(
    "cosmos.operation",
    () => withRetry(
      (attempt) => measureStage("cosmos.attempt", async () => {
        const response = await runBudgetedIO(
          ({ signal }) => operation(attempt, signal),
        );
        logStage("cosmos.response", {
          operation: operationName,
          attempt: attempt + 1,
          rows: response?.resources?.length,
          httpStatus: response?.statusCode,
          requestCharge: response?.requestCharge,
        });
        return response;
      }, { operation: operationName, attempt: attempt + 1 }),
      {
        operationName: `cosmos.${operationName}`,
        maxRetries: RAG_CONFIG.cosmos.maxRetries,
        baseDelayMs: RAG_CONFIG.cosmos.retryBaseDelayMs,
        maxDelayMs: RAG_CONFIG.cosmos.retryMaxDelayMs,
        onRetry: ({ attempt, delayMs, maxRetries }) => {
          console.warn(
            `Cosmos ${label} was throttled or unavailable; retry ${attempt}/${maxRetries} in ${delayMs}ms.`,
          );
        },
      },
    ),
    { operation: operationName },
  );
}

async function runWithConcurrency(items, concurrency, operation) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await operation(item);
    }
  });
  await Promise.all(workers);
}

async function deleteItems(container, brandKey, ids, { ignoreNotFound = false } = {}) {
  await runWithConcurrency(ids, RAG_CONFIG.cosmos.writeConcurrency, (id) =>
    runCosmosOperation(
      async () => {
        try {
          return await container.item(id, brandKey).delete();
        } catch (error) {
          if (ignoreNotFound && isNotFound(error)) return null;
          throw error;
        }
      },
      `delete for item ${id}`,
    ),
  );
}

async function upsertItems(container, items) {
  await runWithConcurrency(items, RAG_CONFIG.cosmos.writeConcurrency, (item) =>
    runCosmosOperation(
      () => container.items.upsert(item),
      `upsert for ${item.recordType || "item"}`,
    ),
  );
}

async function upsertCanonicalProduct(container, productRecord) {
  const duplicateResponse = await runCosmosOperation(
    () => container.items
      .query(
        {
          query: `SELECT VALUE c.id FROM c
            WHERE c.brandKey = @brandKey
              AND c.recordType = "product"
              AND c.productId = @productId
              AND c.id != @canonicalId`,
          parameters: [
            { name: "@brandKey", value: productRecord.brandKey },
            { name: "@productId", value: productRecord.productId },
            { name: "@canonicalId", value: productRecord.id },
          ],
        },
        { partitionKey: productRecord.brandKey },
      )
      .fetchAll(),
    `duplicate-product lookup for ${productRecord.productId}`,
  );
  await runCosmosOperation(
    () => container.items.upsert(productRecord),
    `product upsert for ${productRecord.productId}`,
  );
  await deleteItems(container, productRecord.brandKey, duplicateResponse.resources);
  return duplicateResponse.resources.length;
}

export function buildStructuredProductQuery(brandKey, filters = {}) {
  return buildProductQuery(brandKey, filters, RAG_CONFIG.retrieval.maxStructuredResults);
}

function clearBrandCaches(brandKey) {
  activeRevisionCache.delete(brandKey);
  for (const key of catalogSummaryCache.keys()) {
    if (key === brandKey || key.startsWith(`${brandKey}:`)) {
      catalogSummaryCache.delete(key);
    }
  }
}

export async function getActiveKnowledgeRevision(brandKey, { fresh = false } = {}) {
  const cached = activeRevisionCache.get(brandKey);
  if (!fresh && cached && cached.expiresAt > Date.now()) {
    logStage("cosmos.revision_cache", { brandKey, outcome: "hit" });
    return cached.value;
  }

  logStage("cosmos.revision_cache", { brandKey, outcome: fresh ? "forced_refresh" : "miss" });
  const container = await ensureKnowledgeContainer();
  let value = null;
  try {
    const response = await runCosmosOperation(
      (_attempt, signal) => container
        .item(REVISION_RECORD_ID, brandKey)
        .read(signal ? { abortSignal: signal } : undefined),
      `active-revision read for ${brandKey}`,
    );
    if (response.resource?.activeIngestionId) {
      value = {
        ingestionId: response.resource.activeIngestionId,
        publishedAt: response.resource.publishedAt || null,
        schemaVersion: response.resource.schemaVersion || null,
      };
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  checkResponseBudget();
  activeRevisionCache.set(brandKey, {
    value,
    expiresAt: Date.now() + ACTIVE_REVISION_CACHE_MS,
  });
  return value;
}

/**
 * Publish a complete brand snapshot. New records are invisible until the one
 * revision pointer is changed, so a failed upload leaves the previous snapshot
 * serving customer requests.
 */
export async function publishKnowledgeSnapshot(brandKey, ingestionId, items, metadata = {}) {
  if (!brandKey || !ingestionId || !Array.isArray(items) || items.length === 0) {
    throw new Error("A non-empty brand snapshot and ingestionId are required");
  }
  const ids = new Set();
  for (const item of items) {
    if (item.brandKey !== brandKey || item.ingestionId !== ingestionId) {
      throw new Error(`Snapshot item ${item.id || "(missing id)"} has inconsistent brand or ingestion metadata`);
    }
    if (!item.id || ids.has(item.id)) {
      throw new Error(`Duplicate or missing snapshot item id: ${item.id}`);
    }
    ids.add(item.id);
  }

  const container = await ensureKnowledgeContainer();
  const previousRevision = await getActiveKnowledgeRevision(brandKey, { fresh: true });
  try {
    await upsertItems(container, items);
  } catch (error) {
    await deleteItems(container, brandKey, [...ids], { ignoreNotFound: true }).catch((cleanupError) => {
      console.warn("Failed to clean an unpublished knowledge snapshot:", cleanupError.message);
    });
    throw error;
  }

  let publishedAt = new Date().toISOString();
  const revisionRecord = {
    id: REVISION_RECORD_ID,
    recordType: "knowledge_revision",
    brandKey,
    activeIngestionId: ingestionId,
    schemaVersion: metadata.schemaVersion || "2.0",
    sourceName: metadata.sourceName || null,
    productCount: metadata.productCount || 0,
    documentCount: metadata.documentCount || 0,
    chunkCount: metadata.chunkCount || 0,
    publishedAt,
    status: "active",
  };
  try {
    await runCosmosOperation(
      () => container.items.upsert(revisionRecord),
      `revision publish for ${brandKey}`,
    );
  } catch (error) {
    // A timed-out upsert can still have committed. Confirm the pointer before
    // deleting anything; never erase a snapshot that may already be active.
    clearBrandCaches(brandKey);
    const confirmed = await getActiveKnowledgeRevision(brandKey, { fresh: true })
      .catch(() => null);
    if (confirmed?.ingestionId !== ingestionId) {
      await deleteItems(container, brandKey, [...ids], { ignoreNotFound: true }).catch((cleanupError) => {
        console.warn("Failed to clean an unpublished knowledge snapshot:", cleanupError.message);
      });
      throw error;
    }
    publishedAt = confirmed.publishedAt || publishedAt;
  }
  clearBrandCaches(brandKey);
  activeRevisionCache.set(brandKey, {
    value: { ingestionId, publishedAt, schemaVersion: metadata.schemaVersion || "2.0" },
    expiresAt: Date.now() + ACTIVE_REVISION_CACHE_MS,
  });

  let deleted = 0;
  let cleanupWarning = null;
  try {
    const previousIngestionId = previousRevision?.ingestionId || null;
    if (previousIngestionId !== ingestionId) {
      // Other application instances may still have the old revision pointer in
      // memory. Retain its records until that bounded cache is guaranteed to
      // have expired, then remove only the revision that this upload replaced.
      const cleanupGraceMs = Math.max(
        ACTIVE_REVISION_CACHE_MS,
        Number.isFinite(RAG_CONFIG.retrieval.snapshotCleanupGraceMs)
          ? RAG_CONFIG.retrieval.snapshotCleanupGraceMs
          : ACTIVE_REVISION_CACHE_MS + 5_000,
      );
      if (cleanupGraceMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, cleanupGraceMs));
      }
      const previous = await runCosmosOperation(
        () => container.items.query({
          query: `SELECT VALUE c.id FROM c
            WHERE c.brandKey = @brandKey
              AND (c.recordType = "product" OR c.recordType = "document_chunk")
              AND ${previousIngestionId ? "c.ingestionId = @previousIngestionId" : "NOT IS_DEFINED(c.ingestionId)"}`,
          parameters: [
            { name: "@brandKey", value: brandKey },
            ...(previousIngestionId
              ? [{ name: "@previousIngestionId", value: previousIngestionId }]
              : []),
          ],
        }, { partitionKey: brandKey }).fetchAll(),
        `obsolete-snapshot lookup for ${brandKey}`,
      );
      await deleteItems(container, brandKey, previous.resources, { ignoreNotFound: true });
      deleted = previous.resources.length;
    }
  } catch (error) {
    cleanupWarning = `The new snapshot is active, but obsolete records could not be removed: ${error.message}`;
    console.warn(cleanupWarning);
  }

  return { upserted: items.length, deleted, cleanupWarning, publishedAt };
}

export async function replaceKnowledgeDocument(brandKey, documentId, items) {
  const container = await ensureKnowledgeContainer();
  const productRecords = items.filter((item) => item.recordType === "product");
  const documentItems = items.filter((item) => item.recordType !== "product");
  const sourceName = documentItems[0]?.sourceName || "";
  const sourcePath = documentItems[0]?.sourcePath || "";
  const existing = await runCosmosOperation(
    () => container.items.query(
      {
        query: `SELECT VALUE c.id FROM c
          WHERE c.brandKey = @brandKey
            AND c.recordType = "document_chunk"
            AND (
              c.documentId = @documentId
              OR c.sourcePath = @sourcePath
              OR (NOT IS_DEFINED(c.sourcePath) AND c.sourceName = @sourceName)
            )`,
        parameters: [
          { name: "@brandKey", value: brandKey },
          { name: "@documentId", value: documentId },
          { name: "@sourceName", value: sourceName },
          { name: "@sourcePath", value: sourcePath },
        ],
      },
      { partitionKey: brandKey },
    ).fetchAll(),
    `document lookup for ${documentId}`,
  );

  // Write every new chunk before deleting old evidence. Content-versioned IDs
  // keep the old document intact if an embedding/write fails part-way through.
  // This is not an atomic publish: interrupted writes may temporarily coexist.
  await upsertItems(container, documentItems);
  let deletedDuplicateProducts = 0;
  for (const productRecord of productRecords) {
    deletedDuplicateProducts += await upsertCanonicalProduct(container, productRecord);
  }
  const retainedIds = new Set(items.map(item => item.id));
  const obsoleteIds = existing.resources.filter((id) => !retainedIds.has(id));
  await deleteItems(container, brandKey, obsoleteIds);
  clearBrandCaches(brandKey);

  return {
    deleted: obsoleteIds.length,
    deletedDuplicateProducts,
    upserted: productRecords.length + documentItems.length,
  };
}

export async function upsertProductRecords(productRecords) {
  const container = await ensureKnowledgeContainer();
  let deletedDuplicateProducts = 0;
  for (const productRecord of productRecords) {
    deletedDuplicateProducts += await upsertCanonicalProduct(container, productRecord);
    clearBrandCaches(productRecord.brandKey);
  }
  return {
    deleted: deletedDuplicateProducts,
    deletedDuplicateProducts,
    upserted: productRecords.length,
  };
}

export async function searchStructuredProducts(brandKey, filters = {}, { withMetadata = false } = {}) {
  const span = startStage("cosmos.catalog_search", { brandKey });
  try {
    const limit = Math.min(RAG_CONFIG.retrieval.maxStructuredResults, 10000);
    const container = await ensureKnowledgeContainer();
    const revision = await getActiveKnowledgeRevision(brandKey);
    const response = await runCosmosOperation(
      (_attempt, signal) => container.items
        .query(buildProductQuery(
          brandKey,
          filters,
          limit + (withMetadata ? 1 : 0),
          revision?.ingestionId || null,
        ), { partitionKey: brandKey, ...(signal ? { abortSignal: signal } : {}) })
        .fetchAll(),
      "structured search",
    );
    span.end({
      products: Math.min(
        response.resources.length,
        withMetadata ? limit : response.resources.length,
      ),
      hasMore: withMetadata && response.resources.length > limit,
    });
    if (!withMetadata) return response.resources;
    return {
      products: response.resources.slice(0, limit),
      hasMore: response.resources.length > limit,
      limit,
    };
  } catch (error) {
    span.fail(error);
    throw error;
  }
}

export async function getCatalogSummary(brandKey) {
  const span = startStage("cosmos.catalog_summary", { brandKey });
  try {
    const revision = await getActiveKnowledgeRevision(brandKey);
    const cacheKey = `${brandKey}:${revision?.ingestionId || "legacy"}`;
    const cached = catalogSummaryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      logStage("cosmos.catalog_summary_cache", { brandKey, outcome: "hit" });
      span.end({ outcome: "hit" });
      return cached.value;
    }
    logStage("cosmos.catalog_summary_cache", { brandKey, outcome: "miss" });
    const container = await ensureKnowledgeContainer();
    const [categoryResponse, manufacturerResponse] = await Promise.all([
      runCosmosOperation(
        (_attempt, signal) => container.items.query(
          buildCatalogSummaryQuery(brandKey, revision?.ingestionId || null),
          { partitionKey: brandKey, ...(signal ? { abortSignal: signal } : {}) },
        ).fetchAll(),
        "category summary",
      ),
      runCosmosOperation(
        (_attempt, signal) => container.items.query(
          buildManufacturerSummaryQuery(brandKey, revision?.ingestionId || null),
          { partitionKey: brandKey, ...(signal ? { abortSignal: signal } : {}) },
        ).fetchAll(),
        "manufacturer summary",
      ),
    ]);
    const categories = categoryResponse.resources.map((row) => ({
      category: typeof row.category === "string" && row.category.trim() ? row.category : null,
      productCount: Number(row.productCount) || 0,
    }));
    const manufacturers = manufacturerResponse.resources.map((row) => ({
      manufacturerBrand: typeof row.manufacturerBrand === "string" && row.manufacturerBrand.trim()
        ? row.manufacturerBrand
        : null,
      productCount: Number(row.productCount) || 0,
    }));
    const value = {
      totalProducts: categories.reduce((sum, row) => sum + row.productCount, 0),
      categories,
      manufacturers,
      ingestionId: revision?.ingestionId || null,
    };
    checkResponseBudget();
    catalogSummaryCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + RAG_CONFIG.retrieval.catalogCacheMs,
    });
    span.end({ outcome: "miss", products: value.totalProducts });
    return value;
  } catch (error) {
    span.fail(error);
    throw error;
  }
}

export async function searchKnowledgeChunks(brandKey, queryVector, filters) {
  const span = startStage("cosmos.vector_search", { brandKey });
  try {
    const container = await ensureKnowledgeContainer();
    const revision = await getActiveKnowledgeRevision(brandKey);
    const response = await runCosmosOperation(
      (_attempt, signal) => container.items
        .query(buildVectorQuery(
          brandKey,
          queryVector,
          filters,
          RAG_CONFIG.retrieval.candidateCount,
          revision?.ingestionId || null,
        ), { partitionKey: brandKey, ...(signal ? { abortSignal: signal } : {}) })
        .fetchAll(),
      "vector search",
    );
    span.end({ candidates: response.resources.length, requestCharge: response.requestCharge });
    return response.resources;
  } catch (error) {
    span.fail(error);
    throw error;
  }
}
