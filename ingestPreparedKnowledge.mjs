/**
 * Import the prepared Mr. Brand package using the application's existing
 * catalog normalization, chunking, embedding and snapshot-publishing modules.
 * Run from the application directory. This file can stay in Downloads.
 * No existing application source file is modified.
 *
 * node /path/to/ingestPreparedKnowledge.mjs --source /path/to/Mr_Brand_RAG_Ready.zip \
 *   --brand-key mr-brand --allow-missing-manuals --validate-only
 */
import path from 'node:path';
import {readFile, readdir, stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const VERSION = 'prepared-json-importer-1';
const DIRECTORIES = {
  manuals: {type: 'product_manual', field: 'manualPaths'},
  policies: {type: 'brand_policy', field: null},
  'safety-data-sheets': {type: 'safety_data_sheet', field: 'safetyDataSheetPaths'},
  'catalog-profiles': {type: 'product_catalog', field: 'catalogProfilePaths'}
};
const unique = values => [...new Set(values.filter(Boolean))];
const common = values => {const all = unique(values); return all.length === 1 ? all[0] : '';};
const normalizedPath = value => String(value).replace(/\\/g, '/').replace(/^\.\//, '');
const digest = text => createHash('sha256').update(text).digest('hex');
let RAG_CONFIG, createStableId, normalizeKnowledgeKey, normalizeStringArray;

function optionsFrom(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (['--help', '-h', '--validate-only', '--allow-missing-manuals'].includes(flag)) {
      options[flag.replace(/^--?/, '')] = true;
    } else if (['--source', '--brand-key', '--project'].includes(flag)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`);
      options[flag.slice(2)] = argv[++i];
    } else {
      throw new Error(`Unsupported argument: ${flag}`);
    }
  }
  return options;
}

async function listFiles(root, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
    const rel = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, rel));
    else if (entry.isFile()) files.push(rel);
    else throw new Error(`Unsupported package entry: ${rel}`);
  }
  return files.sort();
}

function productRecord(product, catalog, brandKey, ingestionId, now) {
  return {
    ...product,
    id: createStableId(brandKey, ingestionId, product.productId, 'product'),
    recordType: 'product', brandKey, ingestionId,
    documentId: `product:${normalizeKnowledgeKey(product.productId)}`,
    documentType: 'product_catalog', documentRole: 'product',
    sourceName: catalog.sourceName || 'products.json', sourcePath: 'products.json', sourceType: 'json',
    title: product.productName, status: 'active', schemaVersion: '2.0',
    embeddingModel: RAG_CONFIG.voyage.model, updatedAt: now
  };
}

function documentRecord(document, chunk, index, vector, brandKey, ingestionId, now) {
  const products = document.products;
  const productIds = unique(products.map(p => p.productId));
  const productNames = unique(products.map(p => p.productName));
  const alternateProductIds = unique(products.flatMap(p => p.alternateProductIds || []));
  const modelIds = unique(products.flatMap(p => p.modelIds || []));
  const manufacturerBrands = unique(products.map(p => p.manufacturerBrand));
  return {
    id: createStableId(brandKey, ingestionId, document.documentId, 'chunk', index, chunk.content, RAG_CONFIG.voyage.model),
    recordType: 'document_chunk', brandKey, ingestionId,
    documentId: document.documentId, documentType: document.documentType,
    documentScope: document.documentScope, documentRole: document.documentType,
    sourceName: document.sourceName, sourcePath: document.sourcePath, sourceType: 'json',
    title: document.title, totalPages: document.totalPages,
    productId: productIds[0] || null, productIds, normalizedProductIds: normalizeStringArray(productIds),
    alternateProductIds, normalizedAlternateProductIds: normalizeStringArray(alternateProductIds),
    modelIds, normalizedModelIds: normalizeStringArray(modelIds),
    productName: productNames.join(' / ') || null, productNames,
    normalizedProductName: normalizeStringArray(productNames).join(' '), normalizedProductNames: normalizeStringArray(productNames),
    manufacturerBrand: manufacturerBrands.join(' / ') || null, manufacturerBrands,
    normalizedManufacturerBrand: common(products.map(p => p.normalizedManufacturerBrand)),
    normalizedManufacturerBrands: normalizeStringArray(manufacturerBrands),
    category: common(products.map(p => p.category)), productUse: common(products.map(p => p.productUse)),
    useCases: unique(products.flatMap(p => p.useCases || [])), materials: unique(products.flatMap(p => p.materials || [])),
    colors: unique(products.flatMap(p => p.colors || [])),
    ingredientNames: unique(products.flatMap(p => (p.ingredients || []).map(i => i.normalizedName))),
    originalSourcePath: chunk.originalSourcePath,
    sourceFileSha256: document.source?.suppliedFileSha256 || null,
    sourcePdfName: document.source?.pdfFileName || null,
    referencedOriginalPdfSha256: document.source?.pdfSha256 || null,
    sourceRevisionLines: document.source?.printedRevisionLines || [], sourceReview: document.review || null,
    originalPageStart: chunk.originalPageStart, originalPageEnd: chunk.originalPageEnd,
    pageReferenceKind: chunk.pageReferenceKind, qualityStatus: chunk.qualityStatus, qualityFlags: chunk.qualityFlags,
    sectionNumber: chunk.sectionNumber, sectionTitle: chunk.sectionTitle,
    pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, chunkIndex: index,
    content: chunk.content, embedding: vector,
    embeddingModel: RAG_CONFIG.voyage.model, embeddingDimensions: RAG_CONFIG.cosmos.vectorDimensions,
    status: 'active', schemaVersion: '2.0', updatedAt: now
  };
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  if (options.help || options.h || !options.source || !options['brand-key']) {
    console.log('Usage: node ingestPreparedKnowledge.mjs --source <prepared-folder-or-zip> --brand-key mr-brand [--allow-missing-manuals] [--validate-only] [--project <application-directory>]');
    if (options.help || options.h) return;
    throw new Error('--source and --brand-key are required');
  }
  const project = path.resolve(options.project || process.cwd());
  if (!(await stat(path.join(project, 'package.json')).catch(() => null))?.isFile()) {
    throw new Error('Run this command from your application folder containing package.json, or pass --project.');
  }
  const load = rel => import(pathToFileURL(path.join(project, rel)).href);
  const [archives, documents, chunking, config, brands, normalization] = await Promise.all([
    load('src/services/knowledge/archives/index.js'), load('src/services/knowledge/documents/index.js'),
    load('src/services/knowledge/chunks/index.js'), load('src/config/rag/index.js'),
    load('src/config/brands/index.js'), load('src/common/rag/normalization/index.js')
  ]);
  ({RAG_CONFIG} = config);
  ({createStableId, normalizeKnowledgeKey, normalizeStringArray} = normalization);
  const brand = brands.requireSupportBrand(options['brand-key']);
  console.log('Reading prepared JSON package...');
  const prepared = await archives.prepareKnowledgeSource(path.resolve(options.source));
  try {
    const root = prepared.rootPath;
    const files = await listFiles(root);
    if (!files.includes('products.json')) {
      throw new Error('products.json is not at the package root. Select the inner data/Mr_Brand_RAG_Ready.zip, not Mr_Brand_RAG_Complete.zip.');
    }
    if (files.filter(f => path.posix.basename(f).toLowerCase() === 'products.json').length !== 1) {
      throw new Error('Expected exactly one products.json');
    }
    const catalog = await documents.loadProductCatalogFile(path.join(root, 'products.json'));
    if (!catalog?.products?.length) throw new Error('products.json has no products');
    const productMap = new Map(catalog.products.map(p => [p.productId, p]));
    const links = new Map();
    for (const product of catalog.products) {
      if (!options['allow-missing-manuals'] && !product.manualPaths?.length) {
        throw new Error(`Product ${product.productId} has no manual. This full dataset requires --allow-missing-manuals.`);
      }
      for (const [directory, info] of Object.entries(DIRECTORIES)) {
        if (!info.field) continue;
        for (const suppliedPath of product[info.field] || []) {
          const rel = normalizedPath(suppliedPath);
          if (rel.startsWith('/') || rel.split('/').includes('..') || !rel.startsWith(directory + '/') || !files.includes(rel)) {
            throw new Error(`Invalid or missing ${info.field} for ${product.productId}: ${rel}`);
          }
          if (!links.has(rel)) links.set(rel, []);
          if (!links.get(rel).includes(product.productId)) links.get(rel).push(product.productId);
        }
      }
    }
    const parsed = [], results = [], seenDocumentIds = new Set();
    for (const rel of files) {
      if (rel === 'products.json') continue;
      const directory = rel.split('/')[0];
      const info = DIRECTORIES[directory];
      if (!info || !rel.toLowerCase().endsWith('.json')) throw new Error(`Unsupported prepared document: ${rel}`);
      const definition = JSON.parse(await readFile(path.join(root, rel), 'utf8'));
      if (definition.documentType !== info.type) throw new Error(`Document type does not match its folder: ${rel}`);
      const productIds = links.get(rel) || [];
      const scope = info.field ? 'product' : 'brand';
      if (scope === 'product' && !productIds.length) throw new Error(`No explicit catalog link for ${rel}`);
      if (definition.documentScope !== scope) throw new Error(`Incorrect document scope: ${rel}`);
      if (definition.productIds && JSON.stringify([...definition.productIds].sort()) !== JSON.stringify([...productIds].sort())) {
        throw new Error(`Catalog/document product linkage disagrees: ${rel}`);
      }
      if (!definition.documentId || seenDocumentIds.has(definition.documentId)) throw new Error(`Missing or duplicate document ID: ${rel}`);
      seenDocumentIds.add(definition.documentId);
      if (!Array.isArray(definition.sections) || !definition.sections.length) throw new Error(`No sections in ${rel}`);
      const document = {
        ...definition, sourceName: path.basename(rel), sourcePath: rel, documentScope: scope,
        products: productIds.map(id => productMap.get(id)), totalPages: definition.totalPages ?? null
      };
      const chunks = [];
      for (const section of definition.sections) {
        if (typeof section.content !== 'string' || !section.content.trim()) throw new Error(`Empty prepared section in ${rel}`);
        if (section.sourceContent && !section.content.endsWith(section.sourceContent)) throw new Error(`Incomplete source content in ${rel}`);
        const sectionChunks = chunking.chunkDocument({...document, sections: [section]});
        if (!sectionChunks.length) throw new Error(`No chunks for section ${section.sectionNumber} in ${rel}`);
        for (const chunk of sectionChunks) {
          const originalSourcePath = section.sourcePath || definition.source?.suppliedPath || rel;
          const provenance = [
            !chunk.content.includes(`Supplied source: ${originalSourcePath}`) && `Supplied source: ${originalSourcePath}`,
            section.pageReferenceKind && !chunk.content.includes(`Page reference kind: ${section.pageReferenceKind}`) && `Page reference kind: ${section.pageReferenceKind}`,
            section.qualityStatus && !chunk.content.includes(`Source quality: ${section.qualityStatus}`) && `Source quality: ${section.qualityStatus}`
          ].filter(Boolean).join('\n');
          chunks.push({...chunk, content: provenance ? provenance + '\n' + chunk.content : chunk.content,
            originalSourcePath, originalPageStart: section.originalPageStart ?? null,
            originalPageEnd: section.originalPageEnd ?? null, pageReferenceKind: section.pageReferenceKind || null,
            qualityStatus: section.qualityStatus || null, qualityFlags: section.qualityFlags || []});
        }
      }
      parsed.push({document, chunks});
      results.push({file: rel, documentType: info.type, products: productIds.join(', ') || 'brand-wide',
        pages: document.totalPages || 0, chunks: chunks.length});
    }
    const hash = createHash('sha256');
    hash.update(JSON.stringify({version: VERSION, brandKey: brand.key, products: catalog.products,
      model: RAG_CONFIG.voyage.model, dimensions: RAG_CONFIG.cosmos.vectorDimensions, chunking: RAG_CONFIG.chunking}));
    for (const {document, chunks} of parsed) {
      hash.update(document.sourcePath);
      for (const chunk of chunks) hash.update(chunk.content);
    }
    const ingestionId = hash.digest('hex').slice(0, 40);
    const totalChunks = parsed.reduce((sum, item) => sum + item.chunks.length, 0);
    if (!totalChunks) throw new Error('No chunks prepared');
    const summary = {
      brandKey: brand.key, ingestionId, products: catalog.products.length,
      manuals: results.filter(r => r.documentType === 'product_manual').length,
      policies: results.filter(r => r.documentType === 'brand_policy').length,
      safetyDataSheets: results.filter(r => r.documentType === 'safety_data_sheet').length,
      catalogProfiles: results.filter(r => r.documentType === 'product_catalog').length,
      documents: results.length, pages: results.reduce((sum, r) => sum + r.pages, 0),
      chunks: totalChunks, validationOnly: Boolean(options['validate-only']), published: false
    };
    console.table([summary]);
    if (options['validate-only']) {
      console.log('Validation passed. No embeddings requested, database accessed, or application files changed.');
      return;
    }
    const [{embedDocuments}, {publishKnowledgeSnapshot}, {ensureKnowledgeContainer}] = await Promise.all([
      load('src/api/voyage/embeddings/index.js'), load('src/models/knowledge/store/index.js'),
      load('src/loaders/database/cosmos/index.js')
    ]);
    await ensureKnowledgeContainer();
    console.log(`Generating embeddings for ${totalChunks} chunks using your existing Voyage settings...`);
    const vectors = await embedDocuments(parsed.flatMap(item => item.chunks.map(c => c.content)));
    if (!Array.isArray(vectors) || vectors.length !== totalChunks || vectors.some(v =>
        !Array.isArray(v) || v.length !== RAG_CONFIG.cosmos.vectorDimensions || !v.every(Number.isFinite))) {
      throw new Error('Embedding vectors have an incorrect count, dimensions or numeric values. Snapshot was not published.');
    }
    const now = new Date().toISOString();
    const records = catalog.products.map(p => productRecord(p, catalog, brand.key, ingestionId, now));
    let offset = 0;
    for (const {document, chunks} of parsed) {
      chunks.forEach((chunk, index) => records.push(documentRecord(document, chunk, index,
        vectors[offset++], brand.key, ingestionId, now)));
    }
    console.log(`Publishing ${records.length} records through the existing atomic brand-snapshot publisher...`);
    const published = await publishKnowledgeSnapshot(brand.key, ingestionId, records, {
      schemaVersion: '2.0', sourceName: 'products.json', productCount: catalog.products.length,
      documentCount: parsed.length, chunkCount: totalChunks
    });
    console.table([{...summary, ...published, published: true}]);
    console.log(`Prepared knowledge snapshot ${ingestionId} is active for ${brand.key}.`);
  } finally {
    await prepared.cleanup();
  }
}

await main().catch(error => {
  console.error('Prepared knowledge ingestion failed:', error.message);
  process.exitCode = 1;
});
