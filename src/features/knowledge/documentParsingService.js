import path from "node:path";
import { readFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import {
  normalizeFilterValue,
  normalizeKnowledgeKey,
  normalizeMaterialValue,
  normalizeStringArray,
} from "./knowledge.js";

const SUPPORTED_EXTENSIONS = new Set([".pdf", ".txt", ".md", ".json"]);
const ROOT_PRODUCT_FIELDS = [
  "productId",
  "productName",
  "name",
  "sku",
  "category",
  "productUse",
  "useCases",
  "alternateProductIds",
  "model",
  "modelIds",
  "manufacturerBrand",
  "brand",
  "physicalForm",
  "flammability",
  "materials",
  "material",
  "colors",
  "color",
  "ingredients",
  "price",
  "description",
  "specifications",
  "attributes",
  "features",
  "ragSummary",
  "warrantyMonths",
  "availability",
  "manualPaths",
  "manualFiles",
  "documents",
];

function displayStringArray(values) {
  const input = Array.isArray(values) ? values : values ? [values] : [];
  const strings = input
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return [...new Set(strings)];
}

function compactIdentifier(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeSourcePath(value) {
  return String(value || "").normalize("NFKC").replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizedPathForMatch(value) {
  return normalizeSourcePath(value).toLowerCase().replace(/\s+/g, " ").trim();
}

export function cleanExtractedText(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/\r/g, "")
    .replace(/\u0000|\u00ad/g, "")
    .replace(/([\p{L}])-\n([\p{Ll}])/gu, "$1$2")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter((line) => !/^\d+\s*\/\s*\d+$/.test(line))
    .filter((line) => !/^--\s*\d+\s+of\s+\d+\s*--$/i.test(line))
    .filter((line) => !/^page\s+\d+\s*$/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeIngredients(ingredients) {
  if (!Array.isArray(ingredients)) return [];

  return ingredients
    .map((ingredient) => ({
      name: String(ingredient.name || "").trim(),
      normalizedName: normalizeFilterValue(ingredient.normalizedName || ingredient.name),
      casNumber: ingredient.casNumber || null,
      concentrationPercentage: ingredient.concentrationPercentage == null
        ? null
        : Number(ingredient.concentrationPercentage),
    }))
    .filter((ingredient) => ingredient.name);
}

function documentPathsFromProduct(product) {
  const documentPaths = Array.isArray(product.documents)
    ? product.documents
      .filter((document) => !document?.type || document.type === "manual" || document.type === "product_manual")
      .map((document) => document?.path || document?.sourcePath)
    : [];

  return displayStringArray([
    ...(Array.isArray(product.manualPaths) ? product.manualPaths : []),
    ...(Array.isArray(product.manualFiles) ? product.manualFiles : []),
    ...documentPaths,
  ]).map(normalizeSourcePath);
}

export function normalizeProductMetadata(product = {}, fallbackName = "") {
  const productName = product.productName || product.name || fallbackName;
  const productUse = normalizeFilterValue(product.productUse || product.category);
  const alternateProductIds = displayStringArray(product.alternateProductIds);
  const modelIds = displayStringArray([
    ...(Array.isArray(product.modelIds) ? product.modelIds : []),
    product.model,
    product.specifications?.model,
  ]);
  const manufacturerBrand = String(product.manufacturerBrand || product.brand || "").trim();
  const manualPaths = documentPathsFromProduct(product);

  return {
    ...product,
    productId: String(product.productId || product.sku || "").trim(),
    productName: String(productName || "").trim(),
    normalizedProductName: normalizeFilterValue(productName),
    category: normalizeFilterValue(product.category || product.productUse),
    productUse,
    useCases: normalizeStringArray(product.useCases || productUse),
    alternateProductIds,
    normalizedAlternateProductIds: normalizeStringArray(alternateProductIds),
    modelIds,
    normalizedModelIds: normalizeStringArray(modelIds),
    manufacturerBrand,
    normalizedManufacturerBrand: normalizeFilterValue(manufacturerBrand),
    physicalForm: normalizeFilterValue(product.physicalForm),
    flammability: normalizeFilterValue(product.flammability),
    materials: normalizeStringArray(product.materials || product.material).map(normalizeMaterialValue),
    colors: normalizeStringArray(product.colors || product.color),
    ingredients: normalizeIngredients(product.ingredients),
    features: displayStringArray(product.features),
    manualPaths,
    price: product.price == null ? null : Number(product.price),
  };
}

export async function loadProductCatalogFile(filePath) {
  if (path.extname(filePath).toLowerCase() !== ".json") return null;

  const definition = JSON.parse(await readFile(filePath, "utf8"));
  if (!Array.isArray(definition?.products)) return null;

  const products = definition.products.map((rawProduct, index) => {
    const context = `${path.basename(filePath)} product ${index + 1}`;
    if (!String(rawProduct?.productId || rawProduct?.sku || "").trim()) {
      throw new Error(`${context} has no stable productId`);
    }
    if (!String(rawProduct?.productName || rawProduct?.name || "").trim()) {
      throw new Error(`${context} has no productName`);
    }

    const product = normalizeProductMetadata(rawProduct);
    if (product.price != null && !Number.isFinite(product.price)) {
      throw new Error(`${context} has an invalid price`);
    }
    return product;
  });

  const identifierOwners = new Map();
  for (const product of products) {
    for (const identifier of [product.productId, ...product.alternateProductIds, ...product.modelIds]) {
      const key = compactIdentifier(identifier);
      if (!key) continue;
      const existing = identifierOwners.get(key);
      if (existing && existing !== product.productId) {
        throw new Error(
          `${path.basename(filePath)} identifier ${identifier} belongs to both ${existing} and ${product.productId}`,
        );
      }

      identifierOwners.set(key, product.productId);
    }
  }

  return {
    filePath,
    sourceName: path.basename(filePath),
    schemaVersion: definition.schemaVersion || null,
    metadata: Object.fromEntries(Object.entries(definition).filter(([key]) => key !== "products")),
    products,
  };
}

function identifierMatchesSourceName(identifier, sourceName) {
  const normalizedIdentifier = String(identifier || "").trim().toLowerCase();
  if (!normalizedIdentifier) return false;
  const escaped = normalizedIdentifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(sourceName);
}

function catalogMatch(products, method) {
  return {
    product: products[0] || null,
    products,
    method: products.length ? method : null,
    shared: products.length > 1,
  };
}

export function matchProductCatalogEntryDetailed(filePath, products = [], options = {}) {
  const relativePath = normalizeSourcePath(options.relativePath || path.basename(filePath));
  const normalizedRelativePath = normalizedPathForMatch(relativePath);
  const normalizedBaseName = normalizedPathForMatch(path.basename(relativePath));

  const configuredMatches = products.filter((product) =>
    (product.manualPaths || []).some((candidate) => {
      const normalizedCandidate = normalizedPathForMatch(candidate);
      return normalizedCandidate === normalizedRelativePath
        || normalizedPathForMatch(path.basename(candidate)) === normalizedBaseName;
    }),
  );
  if (configuredMatches.length) return catalogMatch(configuredMatches, "manual_path");

  const legacySourceMatches = products.filter((product) =>
    (product.attributes?.sourceFiles || []).some((candidate) =>
      normalizedPathForMatch(path.basename(candidate)) === normalizedBaseName,
    ),
  );
  if (legacySourceMatches.length) return catalogMatch(legacySourceMatches, "source_file");

  const nameWithoutExtension = path.basename(relativePath, path.extname(relativePath)).toLowerCase();
  const identifierMatches = products.filter((product) =>
    [product.productId, ...(product.alternateProductIds || []), ...(product.modelIds || [])]
      .some((identifier) => identifierMatchesSourceName(identifier, nameWithoutExtension)),
  );
  if (identifierMatches.length) return catalogMatch(identifierMatches, "identifier");
  return catalogMatch([], null);
}

export function matchProductCatalogEntry(filePath, products = [], options = {}) {
  return matchProductCatalogEntryDetailed(filePath, products, options).product;
}

function inferDocumentType(relativePath, definition) {
  if (definition?.documentType) return definition.documentType;
  const normalizedPath = normalizeSourcePath(relativePath).toLowerCase();
  if (/(^|\/)manuals?(\/|$)/.test(normalizedPath)) return "product_manual";
  if (/(^|\/)polic(?:y|ies)(\/|$)/.test(normalizedPath)) return "brand_policy";
  return "knowledge_document";
}

async function extractPdf(filePath) {
  const buffer = await readFile(filePath);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText({ pageJoiner: "" });
    const pages = (result.pages || [])
      .map((page) => ({
        pageNumber: Number(page.num),
        content: cleanExtractedText(page.text),
      }))
      .filter((page) => page.content);
    return {
      text: pages.map((page) => page.content).join("\n\n"),
      pages,
      totalPages: Number(result.total) || pages.length,
    };
  } finally {
    await parser.destroy();
  }
}

async function readDocumentFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported knowledge document type: ${extension}`);
  }

  if (extension === ".pdf") {
    const result = await extractPdf(filePath);
    return { extension, ...result, definition: null };
  }

  const raw = await readFile(filePath, "utf8");
  if (extension !== ".json") {
    return { extension, text: raw, pages: null, totalPages: null, definition: null };
  }

  const definition = JSON.parse(raw);
  const sections = Array.isArray(definition.sections) ? definition.sections : null;
  const sectionText = sections
    ?.map((section) => `${section.title || section.sectionTitle}\n\n${section.content}`)
    .join("\n\n");
  const text = definition.content || definition.text || sectionText || "";
  return { extension, text, pages: null, totalPages: null, definition };
}

function productFieldsFromDefinition(definition) {
  if (!definition?.productName) return {};

  return Object.fromEntries(
    ROOT_PRODUCT_FIELDS
      .filter((key) => definition[key] !== undefined)
      .map((key) => [key, definition[key]]),
  );
}

function catalogProductsFromOptions(options) {
  if (Array.isArray(options.productMetadataList)) {
    return options.productMetadataList.filter(Boolean);
  }
  return options.productMetadata ? [options.productMetadata] : [];
}

function documentTitle(definition, products, product, fallbackName) {
  if (definition?.title) return definition.title;
  if (products.length > 1) {
    return products
      .map((entry) => entry.productName)
      .filter(Boolean)
      .join(" / ");
  }
  return product.productName || fallbackName;
}

export async function parseKnowledgeDocument(filePath, options = {}) {
  const {
    extension,
    text: rawText,
    pages,
    totalPages,
    definition,
  } = await readDocumentFile(filePath);
  const text = cleanExtractedText(rawText);
  if (!text) throw new Error(`No extractable text found in ${filePath}`);

  const sourceName = path.basename(filePath);
  const fallbackName = path.basename(filePath, extension);
  const sourcePath = normalizeSourcePath(options.relativePath || sourceName);
  const catalogProducts = catalogProductsFromOptions(options);
  const catalogProduct = catalogProducts[0] || {};
  const explicitProduct = definition?.product || definition?.metadata?.product || {};
  const rootProduct = productFieldsFromDefinition(definition);
  // Catalog identity wins over metadata embedded in a document. This prevents a
  // mismatched/manual typo from moving evidence to a different product.
  const productMetadata = { ...rootProduct, ...explicitProduct, ...catalogProduct };
  const embeddedProductPresent = Boolean(
    productMetadata.productId || productMetadata.sku || productMetadata.productName || productMetadata.name,
  );
  const products = catalogProducts.length > 1
    ? catalogProducts.map((entry) => normalizeProductMetadata(entry))
    : embeddedProductPresent
      ? [normalizeProductMetadata(productMetadata, fallbackName)]
      : [];
  const hasProductMetadata = products.length > 0;
  const product = products[0] || normalizeProductMetadata({}, "");
  const documentType = options.documentType || inferDocumentType(sourcePath, definition);
  const explicitScope = options.documentScope
    || definition?.documentScope
    || definition?.metadata?.documentScope;
  if (explicitScope && !["brand", "product", "unknown"].includes(explicitScope)) {
    throw new Error(`Invalid documentScope: ${explicitScope}`);
  }
  const documentScope = explicitScope
    || (documentType === "brand_policy" ? "brand" : hasProductMetadata ? "product" : "unknown");
  const sourceKey = normalizeKnowledgeKey(sourcePath.replace(/\.[^.]+$/, ""));
  const documentId = String(
    options.documentId || definition?.documentId || `${normalizeKnowledgeKey(documentType)}:${sourceKey}`,
  );

  return {
    sourceName,
    sourcePath,
    sourceType: extension.slice(1),
    documentId,
    documentType,
    documentScope,
    hasProductMetadata: hasProductMetadata && documentScope !== "brand",
    documentRole: documentType,
    metadataSourceName: options.metadataSourceName || null,
    metadataSourcePath: options.metadataSourcePath || null,
    catalogMatched: catalogProducts.length > 0,
    catalogMatchMethod: options.catalogMatchMethod || null,
    title: documentTitle(definition, products, product, fallbackName),
    text,
    pages,
    totalPages,
    sections: definition?.sections || null,
    product,
    products,
  };
}

export function isSupportedKnowledgeFile(filePath) {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
