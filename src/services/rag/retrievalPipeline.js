import { normalizeFilterValue, normalizeKnowledgeKey } from '../../common/rag/index.js';
import { hasStructuredFilters, uniqueQueries } from '../../common/rag/queryPlan.js';
import { resolveProductReference, productIdentifiers, isConflictingProductChunk } from '../../common/rag/productIdentity.js';
import { contextualFallbackQuery } from '../../common/messaging/context.js';
import { renderProductEvidence } from '../../common/rag/evidenceContext.js';
import { logStage, measureStage, measureSyncStage } from '../../common/utils/timingLogger.js';
import { checkResponseBudget, isResponseTimeout } from '../../common/utils/responseBudget.js';

/**
 * Select evidence chunks under the existing total, per-section, and per-product diversity limits.
 * @param {Array<Object>} candidates - Retrieved evidence candidates.
 * @param {Object} config - RAG retrieval limits and settings.
 * @param {Object} options - Options: productResolved.
 * @returns {Array<Object>} Selected chunks in their existing ranking order.
 */
function selectDiverseChunks(candidates, config, { productResolved = false } = {}) {
  const byId = new Map();
  for (const chunk of candidates) {
    if (!chunk?.id || !Number.isFinite(chunk.distance)) {
      continue;
    }
    if (config.strictDistanceCutoff === true && chunk.distance > config.maxVectorDistance) {
      continue;
    }
    const previous = byId.get(chunk.id);
    if (!previous || chunk.distance < previous.distance) {
      byId.set(chunk.id, chunk);
    }
  }
  const selected = [];
  const perSection = new Map();
  const perProduct = new Map();
  for (const chunk of [...byId.values()].sort((left, right) => left.distance - right.distance)) {
    const key = `${chunk.documentId}:${chunk.sectionNumber ?? chunk.sectionTitle}`;
    const count = perSection.get(key) || 0;
    const unsectioned = !chunk.sectionTitle || chunk.sectionTitle === 'Document';
    const sectionLimit = unsectioned ? config.finalChunkCount : config.maxChunksPerSection || 4;
    if (count >= sectionLimit) {
      continue;
    }
    const productKey =
      Array.isArray(chunk.productIds) && chunk.productIds.length
        ? [...new Set(chunk.productIds)].sort().join('|')
        : chunk.productId || null;
    const productCount = productKey ? perProduct.get(productKey) || 0 : 0;
    if (!productResolved && productKey && productCount >= (config.maxChunksPerProduct || 3)) {
      continue;
    }
    perSection.set(key, count + 1);
    if (productKey) {
      perProduct.set(productKey, productCount + 1);
    }
    selected.push(chunk);
    if (selected.length >= config.finalChunkCount) {
      break;
    }
  }

  return selected;
}

function productSource(product, index) {
  return {
    label: `PRODUCT ${index + 1}`,
    type: 'product',
    documentId: product.documentId,
    sourceName: product.sourceName || 'Product catalog',
    sourcePath: product.sourcePath,
    productName: product.productName
  };
}

function chunkProductIds(chunk) {
  return Array.isArray(chunk.productIds) && chunk.productIds.length ? chunk.productIds : [chunk.productId].filter(Boolean);
}

function chunkProductNames(chunk) {
  return Array.isArray(chunk.productNames) && chunk.productNames.length ? chunk.productNames : [chunk.productName].filter(Boolean);
}

function chunkPageLabel(chunk) {
  if (!Number.isInteger(chunk.pageStart)) {
    return '';
  }
  if (chunk.pageStart === chunk.pageEnd || !Number.isInteger(chunk.pageEnd)) {
    return `; Page: ${chunk.pageStart}`;
  }

  return `; Pages: ${chunk.pageStart}-${chunk.pageEnd}`;
}

/**
 * Render retrieved chunk text with the existing source labels and scope information.
 * @param {Array<Object>} chunks - Document or retrieved evidence chunks.
 * @param {Array<Object>} sources - Mutable citation metadata collected for the selected chunks.
 * @returns {string} The model evidence text for the selected chunks.
 */
function renderChunkEvidence(chunks, sources) {
  const renderedChunks = chunks.map((chunk, index) => {
    const productIds = chunkProductIds(chunk);
    const productNames = chunkProductNames(chunk);
    sources.push({
      label: `SOURCE ${index + 1}`,
      type: 'document',
      documentId: chunk.documentId,
      sourceName: chunk.sourceName,
      sourcePath: chunk.sourcePath,
      documentType: chunk.documentType,
      productName: chunk.productName,
      productNames,
      productId: chunk.productId,
      productIds,
      documentScope: chunk.documentScope,
      sectionNumber: chunk.sectionNumber,
      sectionTitle: chunk.sectionTitle,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      distance: chunk.distance
    });

    return `[SOURCE ${index + 1}] Products: ${productNames.join(' / ') || 'Unspecified'}; Product IDs: ${productIds.join(', ') || 'Unspecified'}; Manufacturer: ${chunk.manufacturerBrand || 'Unspecified'}; Scope: ${chunk.documentScope || 'legacy/unspecified'}; Document: ${chunk.sourcePath || chunk.sourceName}; Section: ${chunk.sectionTitle || 'Document'}${chunkPageLabel(chunk)}\n${chunk.content}`;
  });

  return `RETRIEVED KNOWLEDGE SECTIONS:\n${renderedChunks.join('\n\n')}`;
}

/**
 * Assemble retrieved products, catalog summaries, and chunk evidence into the existing model context.
 * @param {Object} state - Current conversation or pipeline state.
 * @param {Object} config - RAG retrieval limits and settings.
 * @returns {Object} The completed retrieval result and evidence metadata.
 */
function finish(state, config) {
  return measureSyncStage(
    'rag.context_build',
    () => {
      const { products, chunks, plan } = state;
      const sources = products.map(productSource);
      const sections = [];
      let productEvidenceText = '';
      let productEnvelope = '';

      if (state.catalogSummary && plan.intent === 'catalog' && !hasStructuredFilters(plan.filters)) {
        sources.push({
          label: 'CATALOG SUMMARY',
          type: 'catalog',
          sourceName: 'Product catalog'
        });
        sections.push(
          `CATALOG SUMMARY (stored catalog, not live stock or proof of direct retail sales):\n${JSON.stringify(state.catalogSummary)}`
        );
      }

      if (products.length) {
        const catalog = renderProductEvidence(products, {
          compact: config.compactContext !== false,
          plan
        });
        productEvidenceText = catalog.text;
        productEnvelope = `STRUCTURED DATABASE CANDIDATES (${products.length} shown; more matching records: ${state.productsTruncated ? 'yes' : 'no'}). Applied database filters: ${JSON.stringify(state.structuredAppliedFilters || {})}. Requested requirements: ${JSON.stringify(plan.filters)}. Candidate retrieval may be broadened; verify EVERY requested requirement from evidence. A catalog record does not prove live inventory, direct sales, or unstated capabilities.`;
        sections.push(`${productEnvelope}\n${catalog.text}`);
        logStage('rag.context_compaction', {
          brandKey: state.brandKey,
          products: products.length,
          contextBeforeChars: catalog.beforeChars,
          contextSavedChars: catalog.savedChars,
          contextFieldsSavedChars: catalog.fieldsSavedChars,
          sharedValues: catalog.sharedValues,
          enabled: config.compactContext !== false
        });
      }

      if (state.productsTruncated) {
        sections.push(
          'CATALOG LIMIT: The provided products are a partial list. Never call this a complete enumeration; offer to narrow by category or requirement.'
        );
      }
      if (chunks.length) {
        sections.push(renderChunkEvidence(chunks, sources));
      }

      const hasCatalogEvidence =
        plan.intent === 'catalog' && !hasStructuredFilters(plan.filters) && (state.catalogSummary?.totalProducts || 0) > 0;
      const context = sections.join('\n\n---\n\n');
      const dynamicEvidenceText = sections
        .map(section =>
          section.startsWith('STRUCTURED DATABASE CANDIDATES')
            ? `${productEnvelope}\nExact product values are supplied in the preceding cached evidence block.`
            : section
        )
        .join('\n\n---\n\n');
      const result = {
        ...state,
        sources,
        distanceCutoffEnabled: config.strictDistanceCutoff === true,
        context,
        productEvidenceText,
        dynamicEvidenceText,
        hasResults: products.length > 0 || chunks.length > 0 || hasCatalogEvidence
      };
      logStage('rag.context_size', {
        brandKey: state.brandKey,
        products: products.length,
        chunks: chunks.length,
        sources: sources.length,
        evidenceChars: context.length,
        productContextChars: sections.find(section => section.startsWith('STRUCTURED DATABASE CANDIDATES'))?.length || 0,
        chunkContextChars: sections.find(section => section.startsWith('RETRIEVED KNOWLEDGE SECTIONS'))?.length || 0
      });

      return result;
    },
    { brandKey: state.brandKey }
  );
}

/**
 * Bind planning, structured search, vector search, and recovery with the existing retrieval configuration.
 * @param {Object} options - Options: config, createQueryPlan, embedQuery, searchKnowledgeChunks, searchStructuredProducts, getCatalogSummary.
 * @returns {Object} retrieveKnowledge and recoverKnowledge operations.
 */
export function createRetrievalPipeline({
  config,
  createQueryPlan,
  embedQuery,
  searchKnowledgeChunks,
  searchStructuredProducts,
  getCatalogSummary
}) {
  /**
   * Embed and search a semantic query using the existing deadlines and evidence filters.
   * @param {string} brandKey - Canonical support-brand key and knowledge partition.
   * @param {string} query - Semantic search query to embed.
   * @param {Object} identity - Resolved or ambiguous product reference.
   * @param {Array} errors - Existing polling or retrieval failures.
   * @param {Promise<Object>|null} preparedEmbedding - Optional pending embedding result with its status and vector.
   * @returns {Promise<Array<Object>>} Applicable knowledge chunks from the existing vector search.
   */
  async function searchVector(brandKey, query, identity, errors, preparedEmbedding = null) {
    checkResponseBudget();
    let embeddingResult;
    if (preparedEmbedding) {
      embeddingResult = await preparedEmbedding;
    } else {
      const vector = await measureStage('rag.embedding', () => embedQuery(query), { brandKey });
      embeddingResult = { status: 'fulfilled', value: vector };
    }
    if (embeddingResult.status === 'rejected') {
      throw embeddingResult.reason;
    }

    const vector = embeddingResult.value;
    const ids = productIdentifiers(identity);
    // Once a product is resolved, search only its manuals plus brand-wide
    // policies. This prevents a highly similar manual for another model from
    // displacing applicable evidence.
    const branches = ids.length
      ? [
          {
            name: 'product_vector_search',
            filters: { productIds: ids, documentScopes: ['product'] }
          },
          {
            name: 'brand_policy_vector_search',
            filters: { documentScopes: ['brand'] }
          }
        ]
      : [{ name: 'brand_vector_search', filters: {} }];
    const results = await Promise.allSettled(
      branches.map(branch =>
        measureStage('rag.vector_search', () => searchKnowledgeChunks(brandKey, vector, branch.filters), {
          brandKey,
          operation: branch.name,
          productResolution: identity?.status || 'none'
        })
      )
    );
    const candidates = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        candidates.push(...result.value);
        continue;
      }
      if (isResponseTimeout(result.reason)) {
        throw result.reason;
      }
      errors.push(branches[index].name);
    }
    if (results.every(result => result.status === 'rejected')) {
      throw new Error('All vector branches failed');
    }

    return candidates;
  }

  function choose(candidates, identity) {
    return selectDiverseChunks(
      candidates.filter(chunk => !isConflictingProductChunk(chunk, identity)),
      config,
      { productResolved: identity?.status === 'resolved' }
    );
  }

  /**
   * Run the existing targeted recovery search after insufficient evidence or an answer failure.
   * @param {Object} previous - Prior retrieval result containing the plan and evidence.
   * @returns {Promise<Object>} The recovered retrieval state and evidence context.
   */
  async function recoverKnowledge(previous) {
    checkResponseBudget();
    if (!config.recoveryEnabled || previous.recoveryAttempted) {
      logStage('rag.recovery_skipped', {
        reason: !config.recoveryEnabled ? 'disabled' : 'already_attempted'
      });

      return previous;
    }

    const tried = new Set(previous.queriesTried.map(normalizeFilterValue));
    const fallbackQuery = contextualFallbackQuery(previous.question, previous.history, previous.conversationState);
    const queries = uniqueQueries([...(previous.plan.alternativeQueries || []), fallbackQuery, previous.question])
      .filter(query => !tried.has(normalizeFilterValue(query)))
      .slice(0, config.maxRecoveryQueries);
    const errors = [...previous.errors];
    const results = await Promise.allSettled(
      queries.map(query => searchVector(previous.brandKey, query, previous.productIdentity, errors))
    );
    const candidates = [...(previous.candidates || previous.chunks)];
    let candidateCount = previous.candidateCount;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        candidates.push(...result.value);
        candidateCount += result.value.length;
        continue;
      }

      if (isResponseTimeout(result.reason)) {
        throw result.reason;
      }
      errors.push('recovery_vector_search');
      console.warn('RAG recovery search failed:', result.reason?.message);
    }

    let catalog = {};
    const canBroadenCatalog =
      previous.plan.intent === 'product_search' && !previous.structuredBroadened && hasStructuredFilters(previous.plan.filters);
    if (canBroadenCatalog) {
      try {
        const broad = await measureStage(
          'rag.catalog_search',
          () => searchStructuredProducts(previous.brandKey, {}, { withMetadata: true }),
          { brandKey: previous.brandKey, broadened: true, recovery: true }
        );
        catalog = {
          products: broad.products,
          productsTruncated: broad.hasMore,
          structuredBroadened: true,
          structuredAppliedFilters: {}
        };
      } catch (error) {
        if (isResponseTimeout(error)) {
          throw error;
        }
        errors.push('catalog_recovery');
      }
    }

    const chunks = measureSyncStage('rag.chunk_selection', () => choose(candidates, previous.productIdentity), {
      brandKey: previous.brandKey,
      candidates: candidates.length,
      recovery: true
    });

    return finish(
      {
        ...previous,
        ...catalog,
        candidates,
        chunks,
        candidateCount,
        errors,
        queriesTried: [...previous.queriesTried, ...queries],
        recoveryAttempted: true
      },
      config
    );
  }

  /**
   * Plan and execute the existing structured and vector searches for one customer question.
   * @param {Object} options - Options: brand, question, history, conversationState.
   * @returns {Promise<Object>} The retrieval result with products, chunks, context, and source labels.
   */
  async function retrieveKnowledge({ brand, question, history = '', conversationState = {} }) {
    checkResponseBudget();
    const brandKey = normalizeKnowledgeKey(brand);
    const errors = [];
    let catalogSummary = null;
    try {
      catalogSummary = await measureStage('rag.catalog_summary', () => getCatalogSummary(brandKey), { brandKey });
    } catch (error) {
      if (isResponseTimeout(error)) {
        throw error;
      }
      errors.push('catalog_summary');
      console.warn('RAG catalog summary unavailable:', error.message);
    }

    const catalogCategories = (catalogSummary?.categories || []).map(row => row.category).filter(Boolean);
    const catalogManufacturers = (catalogSummary?.manufacturers || []).map(row => row.manufacturerBrand).filter(Boolean);
    const plan = await measureStage(
      'rag.planner',
      () =>
        createQueryPlan(question, {
          brand,
          history,
          conversationState,
          catalogCategories,
          catalogManufacturers
        }),
      { brandKey }
    );
    logStage('rag.plan_ready', {
      brandKey,
      plannerSource: plan.plannerSource,
      intent: plan.intent,
      supportGoal: plan.supportGoal,
      turnType: plan.turnType,
      requiresProductIdentity: plan.requiresProductIdentity
    });
    // The semantic query is ready now; embedding it does not need catalog or
    // product identity. Observe failures immediately while the lookup runs.
    // Actual vector searches still wait for identity and retain their filters.
    const preparedEmbedding =
      plan.turnType === 'conversation'
        ? null
        : Promise.resolve()
            .then(() => measureStage('rag.embedding', () => embedQuery(plan.semanticQuery), { brandKey }))
            .then(
              value => ({ status: 'fulfilled', value }),
              reason => ({ status: 'rejected', reason })
            );
    const needsCatalog =
      plan.intent === 'catalog' || plan.intent === 'product_search' || plan.requiresProductIdentity || hasStructuredFilters(plan.filters);
    let catalogResult = { products: [], hasMore: false };
    let structuredAppliedFilters = needsCatalog ? plan.filters : {};
    let structuredBroadened = false;
    if (needsCatalog && plan.turnType !== 'conversation') {
      try {
        catalogResult = await measureStage(
          'rag.catalog_search',
          () =>
            searchStructuredProducts(brandKey, plan.filters, {
              withMetadata: true
            }),
          { brandKey, broadened: false }
        );
        if (!catalogResult.products.length && hasStructuredFilters(plan.filters)) {
          catalogResult = await measureStage('rag.catalog_search', () => searchStructuredProducts(brandKey, {}, { withMetadata: true }), {
            brandKey,
            broadened: true
          });
          structuredAppliedFilters = {};
          structuredBroadened = true;
        }
      } catch (error) {
        if (isResponseTimeout(error)) {
          throw error;
        }
        errors.push('catalog_search');
        console.warn('Catalog search failed:', error.message);
      }
    }
    const identityReference = plan.filters.productName || (plan.requiresProductIdentity ? question : null);
    const productIdentity = measureSyncStage(
      'rag.product_identity',
      () =>
        resolveProductReference(identityReference, catalogResult.products, {
          truncated: catalogResult.hasMore
        }),
      { brandKey }
    );
    logStage('rag.product_identity_result', {
      brandKey,
      productResolution: productIdentity.status,
      products: catalogResult.products.length,
      hasMore: catalogResult.hasMore,
      broadened: structuredBroadened
    });
    if (plan.intent === 'knowledge') {
      const hasMatchedProducts = productIdentity.status === 'resolved' || productIdentity.status === 'ambiguous';
      catalogResult = {
        products: hasMatchedProducts ? productIdentity.products : [],
        hasMore: false
      };
    }

    let candidates = [];
    if (plan.turnType !== 'conversation') {
      try {
        candidates = await searchVector(brandKey, plan.semanticQuery, productIdentity, errors, preparedEmbedding);
      } catch (error) {
        if (isResponseTimeout(error)) {
          throw error;
        }
        errors.push('vector_search');
        console.warn('Vector search failed:', error.message);
      }
    }

    const chunks = measureSyncStage('rag.chunk_selection', () => choose(candidates, productIdentity), {
      brandKey,
      candidates: candidates.length
    });
    const result = finish(
      {
        brandKey,
        question,
        history: plan.topicChanged ? '' : history,
        conversationState: plan.topicChanged ? {} : conversationState,
        plan,
        vectorFilters: {},
        catalogSummary,
        productIdentity,
        structuredAppliedFilters,
        structuredBroadened,
        candidates,
        products: catalogResult.products,
        productsTruncated: catalogResult.hasMore,
        chunks,
        candidateCount: candidates.length,
        queriesTried: plan.turnType === 'conversation' ? [] : [plan.semanticQuery],
        recoveryAttempted: plan.turnType === 'conversation',
        errors
      },
      config
    );
    // Let the answer model ask a useful question before spending on recovery.
    // The reply pipeline recovers only when the model reports missing evidence.
    return result;
  }

  return { retrieveKnowledge, recoverKnowledge };
}
