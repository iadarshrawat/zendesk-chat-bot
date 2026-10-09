import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { RAG_CONFIG } from '../../config/rag.js';
import { requireSupportBrand } from '../../config/brands.js';
import { chunkDocument } from './chunks.js';
import { isSupportedKnowledgeFile, loadProductCatalogFile, matchProductCatalogEntryDetailed, parseKnowledgeDocument } from './documents.js';
import { isIgnoredKnowledgePath } from './archives.js';
import { embedDocuments } from '../../api/voyage/embeddings.js';
import { publishKnowledgeSnapshot } from '../../models/knowledge/index.js';
import { createStableId, normalizeKnowledgeKey, normalizeStringArray } from '../../common/rag/index.js';

function relativeSourcePath(sourceRoot, filePath) {
  return path.relative(sourceRoot, filePath).replace(/\\/g, '/');
}

function isManualPath(relativePath) {
  return /(^|\/)manuals?(\/|$)/i.test(relativePath.replace(/\\/g, '/'));
}

function isPolicyPath(relativePath) {
  return /(^|\/)polic(?:y|ies)(\/|$)/i.test(relativePath.replace(/\\/g, '/'));
}

function productsFromCatalogMatch(match) {
  if (match.products?.length) {
    return match.products;
  }

  return match.product ? [match.product] : [];
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function onlyCommonValue(values) {
  const distinct = uniqueValues(values);

  return distinct.length === 1 ? distinct[0] : '';
}

function productsForDocument(document) {
  if (document.documentScope !== 'product') {
    return [];
  }
  if (Array.isArray(document.products) && document.products.length) {
    return document.products;
  }

  return document.product?.productId ? [document.product] : [];
}

/**
 * Build the canonical catalog record with stable identity and resolved manual paths.
 * @param {Object} product - Normalized catalog product.
 * @param {Object} catalog - Validated product catalog.
 * @param {string} brandKey - Canonical support-brand key and knowledge partition.
 * @param {string} ingestionId - Knowledge revision identity.
 * @param {string} now - UTC ISO timestamp for this ingestion revision.
 * @param {Array<string>} resolvedManualPaths - Validated manual paths for this product.
 * @returns {Object} The product record for the knowledge revision.
 */
function buildProductRecord(product, catalog, brandKey, ingestionId, now, resolvedManualPaths = []) {
  const canonicalProductId = product.productId;
  const manualPaths = [...new Set([...(product.manualPaths || []), ...resolvedManualPaths])].sort();

  return {
    ...product,
    manualPaths,
    id: createStableId(brandKey, ingestionId || 'legacy', canonicalProductId, 'product'),
    recordType: 'product',
    brandKey,
    ingestionId: ingestionId || undefined,
    documentId: `product:${normalizeKnowledgeKey(canonicalProductId)}`,
    documentType: 'product_catalog',
    documentRole: 'product',
    sourceName: catalog?.sourceName || 'products.json',
    sourcePath: catalog?.sourcePath || 'products.json',
    sourceType: 'json',
    title: product.productName,
    status: 'active',
    schemaVersion: '2.0',
    embeddingModel: RAG_CONFIG.voyage.model,
    updatedAt: now
  };
}

/**
 * Attach catalog identity, document metadata, and validated vectors to each knowledge chunk.
 * @param {Object} document - Parsed knowledge document.
 * @param {Array<Object>} chunks - Document or retrieved evidence chunks.
 * @param {Array<Array<number>>} embeddings - Vectors matching the document chunks.
 * @param {string} brandKey - Canonical support-brand key and knowledge partition.
 * @param {string} ingestionId - Knowledge revision identity.
 * @param {string} now - UTC ISO timestamp for this ingestion revision.
 * @returns {Array<Object>} Cosmos-ready document chunk records.
 */
function buildDocumentChunkRecords(document, chunks, embeddings, brandKey, ingestionId, now) {
  if (!Array.isArray(embeddings) || embeddings.length !== chunks.length) {
    throw new Error(`Embedding count does not match chunks for ${document.sourceName}`);
  }

  const products = productsForDocument(document);
  const productIds = uniqueValues(products.map(product => product.productId));
  const productNames = uniqueValues(products.map(product => product.productName));
  const alternateProductIds = uniqueValues(products.flatMap(product => product.alternateProductIds || []));
  const modelIds = uniqueValues(products.flatMap(product => product.modelIds || []));
  const manufacturerBrands = uniqueValues(products.map(product => product.manufacturerBrand));
  const ingredientNames = uniqueValues(
    products.flatMap(product => (product.ingredients || []).map(ingredient => ingredient.normalizedName))
  );

  return chunks.map((chunk, index) => ({
    id: createStableId(brandKey, ingestionId || 'legacy', document.documentId, 'chunk', index, chunk.content, RAG_CONFIG.voyage.model),
    recordType: 'document_chunk',
    brandKey,
    ingestionId: ingestionId || undefined,
    documentId: document.documentId,
    documentType: document.documentType,
    documentScope: document.documentScope,
    sourceName: document.sourceName,
    sourcePath: document.sourcePath,
    sourceType: document.sourceType,
    documentRole: document.documentRole,
    title: document.title,
    totalPages: document.totalPages || null,
    productId: productIds[0] || null,
    productIds,
    normalizedProductIds: normalizeStringArray(productIds),
    alternateProductIds,
    normalizedAlternateProductIds: normalizeStringArray(alternateProductIds),
    modelIds,
    normalizedModelIds: normalizeStringArray(modelIds),
    productName: productNames.join(' / ') || null,
    productNames,
    normalizedProductName: normalizeStringArray(productNames).join(' '),
    normalizedProductNames: normalizeStringArray(productNames),
    manufacturerBrand: manufacturerBrands.join(' / ') || null,
    manufacturerBrands,
    normalizedManufacturerBrand: onlyCommonValue(products.map(product => product.normalizedManufacturerBrand)),
    normalizedManufacturerBrands: normalizeStringArray(manufacturerBrands),
    category: onlyCommonValue(products.map(product => product.category)),
    productUse: onlyCommonValue(products.map(product => product.productUse)),
    useCases: uniqueValues(products.flatMap(product => product.useCases || [])),
    materials: uniqueValues(products.flatMap(product => product.materials || [])),
    colors: uniqueValues(products.flatMap(product => product.colors || [])),
    ingredientNames,
    sectionNumber: chunk.sectionNumber,
    sectionTitle: chunk.sectionTitle,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    chunkIndex: index,
    content: chunk.content,
    embedding: embeddings[index],
    embeddingModel: RAG_CONFIG.voyage.model,
    embeddingDimensions: RAG_CONFIG.cosmos.vectorDimensions,
    status: 'active',
    schemaVersion: '2.0',
    updatedAt: now
  }));
}

/**
 * Recursively collect supported knowledge sources while skipping the existing ignored paths.
 * @param {string} sourcePath - Local supported document or directory to scan.
 * @returns {Promise<Array<string>>} Knowledge source file paths.
 */
async function collectKnowledgeFiles(sourcePath) {
  const sourceStat = await stat(sourcePath);
  if (sourceStat.isFile()) {
    if (!isSupportedKnowledgeFile(sourcePath)) {
      throw new Error(`Unsupported knowledge file: ${sourcePath}`);
    }

    return [sourcePath];
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`Knowledge source must be a file or directory: ${sourcePath}`);
  }

  const files = [];
  for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
    if (isIgnoredKnowledgePath(entry.name)) {
      continue;
    }
    const entryPath = path.join(sourcePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectKnowledgeFiles(entryPath)));
    } else if (entry.isFile() && isSupportedKnowledgeFile(entryPath)) {
      files.push(entryPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

/**
 * Load the package's required catalog and reject missing or duplicate catalogs.
 * @param {Array<string>} files - Absolute paths to files in the knowledge package.
 * @param {string} sourceRoot - Knowledge package root.
 * @returns {Promise<Object>} The validated catalog; throws for an invalid package.
 */
async function loadPackageCatalog(files, sourceRoot) {
  const catalogFiles = files.filter(file => path.basename(file).toLowerCase() === 'products.json');
  if (catalogFiles.length !== 1) {
    throw new Error(`A brand package must contain exactly one products.json; found ${catalogFiles.length}`);
  }
  const catalog = await loadProductCatalogFile(catalogFiles[0]);
  if (!catalog) {
    throw new Error('products.json must contain a root products array');
  }

  return {
    ...catalog,
    sourcePath: relativeSourcePath(sourceRoot, catalogFiles[0])
  };
}

/**
 * Match package documents to catalog products and validate product/manual relationships.
 * @param {Array<string>} files - Absolute paths to files in the knowledge package.
 * @param {string} sourceRoot - Knowledge package root.
 * @param {Object} catalog - Validated product catalog.
 * @param {Object} options - Options: requireManuals.
 * @returns {Object} The validated package ingestion plan.
 */
function buildPackagePlan(files, sourceRoot, catalog, { requireManuals = true } = {}) {
  const plans = [];
  const manualsByProduct = new Map(catalog.products.map(product => [product.productId, []]));
  const catalogPath = path.resolve(catalog.filePath);

  for (const filePath of files) {
    if (path.resolve(filePath) === catalogPath) {
      continue;
    }
    const relativePath = relativeSourcePath(sourceRoot, filePath);
    if (path.basename(relativePath).toLowerCase() === 'brand.json') {
      continue;
    }
    if (isManualPath(relativePath)) {
      const match = matchProductCatalogEntryDetailed(filePath, catalog.products, { relativePath });
      const matchedProducts = productsFromCatalogMatch(match);
      if (!matchedProducts.length) {
        throw new Error(
          `Manual ${relativePath} is not linked to a product. Add manualPaths to products.json or include a unique product/model identifier in its filename.`
        );
      }
      for (const product of matchedProducts) {
        manualsByProduct.get(product.productId).push(relativePath);
      }
      plans.push({
        filePath,
        relativePath,
        productMetadata: matchedProducts[0],
        productMetadataList: matchedProducts,
        catalogMatchMethod: match.method,
        documentType: 'product_manual',
        documentScope: 'product'
      });
      continue;
    }
    if (isPolicyPath(relativePath)) {
      plans.push({
        filePath,
        relativePath,
        productMetadata: null,
        catalogMatchMethod: null,
        documentType: 'brand_policy',
        documentScope: 'brand'
      });
      continue;
    }
    throw new Error(
      `Unsupported package document location: ${relativePath}. Put product documents in manuals/ and brand-wide documents in policies/.`
    );
  }

  const availableManuals = new Set(
    plans.filter(plan => plan.documentType === 'product_manual').map(plan => plan.relativePath.toLowerCase())
  );
  const availableManualBasenames = new Set([...availableManuals].map(manualPath => path.basename(manualPath)));
  for (const product of catalog.products) {
    for (const configuredPath of product.manualPaths || []) {
      const normalizedConfiguredPath = configuredPath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
      if (!availableManuals.has(normalizedConfiguredPath) && !availableManualBasenames.has(path.basename(normalizedConfiguredPath))) {
        throw new Error(`Configured manualPath does not exist for ${product.productId}: ${configuredPath}`);
      }
    }
  }

  if (requireManuals) {
    const missing = [...manualsByProduct.entries()].filter(([, manualPaths]) => manualPaths.length === 0).map(([productId]) => productId);
    if (missing.length) {
      throw new Error(`Products without a matching manual: ${missing.join(', ')}`);
    }
  }
  if (!plans.length) {
    throw new Error('The brand package contains no manual or policy documents');
  }

  return { plans, manualsByProduct };
}

/**
 * Parse each planned document using the package's resolved product metadata.
 * @param {Array<Object>} plans - Documents with resolved product metadata and scope.
 * @param {Object} catalog - Validated product catalog.
 * @returns {Promise<Array<Object>>} Parsed documents ready for snapshot construction.
 */
async function parsePackageDocuments(plans, catalog) {
  const documents = [];
  for (const plan of plans) {
    const document = await parseKnowledgeDocument(plan.filePath, {
      relativePath: plan.relativePath,
      productMetadata: plan.productMetadata,
      productMetadataList: plan.productMetadataList || [],
      catalogMatchMethod: plan.catalogMatchMethod,
      metadataSourceName: plan.productMetadata ? catalog.sourceName : null,
      metadataSourcePath: plan.productMetadata ? catalog.sourcePath : null,
      documentType: plan.documentType,
      documentScope: plan.documentScope
    });
    const chunks = chunkDocument(document);
    if (!chunks.length) {
      throw new Error(`No chunks generated for ${plan.relativePath}`);
    }
    documents.push({ document, chunks });
  }

  return documents;
}

/**
 * Hash the package's canonical products and documents into a stable knowledge revision ID.
 * @param {string} brandKey - Canonical support-brand key and knowledge partition.
 * @param {Object} catalog - Validated product catalog.
 * @param {Array<Object>} documents - Parsed package documents and their chunks.
 * @returns {string} The deterministic snapshot identity.
 */
function snapshotIdFor(brandKey, catalog, documents) {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      brandKey,
      products: catalog.products,
      model: RAG_CONFIG.voyage.model,
      dimensions: RAG_CONFIG.cosmos.vectorDimensions,
      chunking: RAG_CONFIG.chunking
    })
  );
  for (const { document, chunks } of documents) {
    hash.update(document.sourcePath);
    for (const chunk of chunks) {
      hash.update(chunk.content);
    }
  }

  return hash.digest('hex').slice(0, 40);
}

/**
 * Summarize the existing per-document package ingestion outcomes.
 * @param {Array<Object>} documents - Parsed package documents and their chunks.
 * @returns {Array<Object>} Document results returned by package ingestion.
 */
function packageResults(documents) {
  return documents.map(({ document, chunks }) => {
    const products = document.products || [];

    return {
      file: document.sourceName,
      sourcePath: document.sourcePath,
      documentId: document.documentId,
      documentType: document.documentType,
      productId: products[0]?.productId || null,
      productIds: products.map(product => product.productId),
      productName: products[0]?.productName || null,
      productNames: products.map(product => product.productName),
      sharedProductManual: products.length > 1,
      catalogMatched: document.catalogMatched,
      catalogMatchMethod: document.catalogMatchMethod,
      pages: document.totalPages,
      chunks: chunks.length
    };
  });
}

/**
 * Ingest a validated brand package and publish its atomic knowledge snapshot.
 * @param {string} sourcePath - Extracted brand package directory containing products.json and documents.
 * @param {Object} options - Brand key, validateOnly flag, and optional requireManuals flag.
 * @returns {Promise<Object>} The existing ingestion summary and document results.
 */
export async function ingestKnowledgePath(sourcePath, options = {}) {
  const brand = requireSupportBrand(options.brandKey || options.brand);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isDirectory()) {
    throw new Error('Complete brand ingestion requires an extracted package directory');
  }
  const files = await collectKnowledgeFiles(sourcePath);
  if (!files.length) {
    throw new Error(`No supported documents found in ${sourcePath}`);
  }

  const catalog = await loadPackageCatalog(files, sourcePath);
  const { plans, manualsByProduct } = buildPackagePlan(files, sourcePath, catalog, {
    requireManuals: options.requireManuals !== false
  });
  const documents = await parsePackageDocuments(plans, catalog);
  const ingestionId = snapshotIdFor(brand.key, catalog, documents);
  const results = packageResults(documents);
  const summary = {
    brandKey: brand.key,
    brandName: brand.displayName,
    ingestionId,
    products: catalog.products.length,
    manuals: plans.filter(plan => plan.documentType === 'product_manual').length,
    sharedManuals: results.filter(result => result.sharedProductManual).length,
    policies: plans.filter(plan => plan.documentType === 'brand_policy').length,
    documents: documents.length,
    pages: results.reduce((sum, result) => sum + (result.pages || 0), 0),
    chunks: results.reduce((sum, result) => sum + result.chunks, 0),
    matchMethods: Object.fromEntries(
      [...new Set(results.map(result => result.catalogMatchMethod).filter(Boolean))].map(method => [
        method,
        results.filter(result => result.catalogMatchMethod === method).length
      ])
    ),
    validationOnly: options.validateOnly === true,
    published: false
  };
  if (options.validateOnly) {
    return { summary, results };
  }

  const allChunks = documents.flatMap(({ chunks }) => chunks.map(chunk => chunk.content));
  const allEmbeddings = await embedDocuments(allChunks);
  let embeddingOffset = 0;
  const now = new Date().toISOString();
  const productRecords = catalog.products.map(product =>
    buildProductRecord(product, catalog, brand.key, ingestionId, now, manualsByProduct.get(product.productId) || [])
  );
  const chunkRecords = documents.flatMap(({ document, chunks }) => {
    const documentEmbeddings = allEmbeddings.slice(embeddingOffset, embeddingOffset + chunks.length);
    embeddingOffset += chunks.length;

    return buildDocumentChunkRecords(document, chunks, documentEmbeddings, brand.key, ingestionId, now);
  });
  const writeResult = await publishKnowledgeSnapshot(brand.key, ingestionId, [...productRecords, ...chunkRecords], {
    schemaVersion: '2.0',
    sourceName: catalog.sourceName,
    productCount: productRecords.length,
    documentCount: documents.length,
    chunkCount: chunkRecords.length
  });

  return {
    summary: { ...summary, published: true, ...writeResult },
    results
  };
}
