import { normalizeFilterValue, normalizeMaterialValue } from '../../common/rag/index.js';

function boundedLimit(value, fallback) {
  const requested = Number(value);

  return Number.isInteger(requested) && requested > 0 ? Math.min(requested, 10001) : fallback;
}

function addParameter(parameters, name, value) {
  parameters.push({ name, value });

  return name;
}

function applyIngestionFilter(conditions, parameters, ingestionId) {
  if (!ingestionId) {
    return;
  }
  conditions.push('c.ingestionId = @ingestionId');
  addParameter(parameters, '@ingestionId', ingestionId);
}

/**
 * Build parameterized product search using the existing catalog filters and result limit.
 * @param {string} brandKey - Canonical support-brand key and knowledge partition.
 * @param {Object} filters - Existing search filters.
 * @param {number} requestedLimit - Maximum requested result count, bounded by the query builder.
 * @param {string} ingestionId - Knowledge revision identity.
 * @returns {Object} Cosmos query text and parameters.
 */
export function buildStructuredProductQuery(brandKey, filters = {}, requestedLimit = 100, ingestionId = null) {
  const limit = boundedLimit(requestedLimit, 100);
  const conditions = ['c.brandKey = @brandKey', 'c.recordType = "product"', 'c.status = "active"'];
  const parameters = [{ name: '@brandKey', value: brandKey }];
  applyIngestionFilter(conditions, parameters, ingestionId);

  if (filters.productName) {
    conditions.push(`(
      CONTAINS(c.normalizedProductName, @productName)
      OR CONTAINS(LOWER(c.productId), @productName)
      OR ARRAY_CONTAINS(c.normalizedAlternateProductIds, @productName)
      OR ARRAY_CONTAINS(c.normalizedModelIds, @productName)
    )`);
    addParameter(parameters, '@productName', normalizeFilterValue(filters.productName));
  }
  if (Array.isArray(filters.productIds) && filters.productIds.length) {
    conditions.push(
      '(ARRAY_CONTAINS(@productIds, LOWER(c.productId)) OR EXISTS (SELECT VALUE a FROM a IN c.normalizedAlternateProductIds WHERE ARRAY_CONTAINS(@productIds, a)))'
    );
    const productIds = filters.productIds.map(normalizeFilterValue);
    addParameter(parameters, '@productIds', productIds);
  }
  if (filters.category) {
    conditions.push('c.category = @category');
    addParameter(parameters, '@category', normalizeFilterValue(filters.category));
  }
  if (filters.manufacturerBrand) {
    conditions.push('c.normalizedManufacturerBrand = @manufacturerBrand');
    addParameter(parameters, '@manufacturerBrand', normalizeFilterValue(filters.manufacturerBrand));
  }
  if (filters.productUse) {
    conditions.push('(c.productUse = @productUse OR ARRAY_CONTAINS(c.useCases, @productUse))');
    addParameter(parameters, '@productUse', normalizeFilterValue(filters.productUse));
  }
  if (filters.material) {
    conditions.push('ARRAY_CONTAINS(c.materials, @material)');
    addParameter(parameters, '@material', normalizeMaterialValue(filters.material));
  }
  if (filters.color) {
    conditions.push('ARRAY_CONTAINS(c.colors, @color)');
    addParameter(parameters, '@color', normalizeFilterValue(filters.color));
  }
  if (filters.maxPrice != null) {
    conditions.push('IS_NUMBER(c.price) AND c.price <= @maxPrice');
    addParameter(parameters, '@maxPrice', Number(filters.maxPrice));
  }

  if (filters.ingredient) {
    const ingredientConditions = ['i.normalizedName = @ingredient'];
    addParameter(parameters, '@ingredient', normalizeFilterValue(filters.ingredient));
    if (filters.minConcentrationPercentage != null) {
      ingredientConditions.push('IS_NUMBER(i.concentrationPercentage) AND i.concentrationPercentage >= @minConcentration');
      addParameter(parameters, '@minConcentration', Number(filters.minConcentrationPercentage));
    }
    conditions.push(`EXISTS (SELECT VALUE i FROM i IN c.ingredients WHERE ${ingredientConditions.join(' AND ')})`);
  }

  return {
    query: `SELECT TOP ${limit} c.id, c.productId, c.alternateProductIds, c.modelIds, c.productName, c.manufacturerBrand, c.distributor, c.category, c.productUse, c.useCases, c.materials, c.colors, c.price, c.physicalForm, c.flammability, c.ingredients, c.features, c.description, c.ragSummary, c.specifications, c.attributes, c.warrantyMonths, c.availability, c.manualPaths, c.documentId, c.sourceName, c.sourcePath FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.id`,
    parameters
  };
}

/**
 * Build a brand-scoped vector query with the existing document and product constraints.
 * @param {string} brandKey - Canonical support-brand key and knowledge partition.
 * @param {Array<number>} queryVector - Embedded customer query used for vector search.
 * @param {Object} filters - Existing search filters.
 * @param {number} requestedLimit - Maximum requested result count, bounded by the query builder.
 * @param {string} ingestionId - Knowledge revision identity.
 * @returns {Object} Cosmos vector query text and parameters.
 */
export function buildVectorQuery(brandKey, queryVector, filters = {}, requestedLimit = 16, ingestionId = null) {
  const topK = boundedLimit(requestedLimit, 16);
  const conditions = ['c.brandKey = @brandKey', 'c.recordType = "document_chunk"', 'c.status = "active"'];
  const parameters = [
    { name: '@brandKey', value: brandKey },
    { name: '@queryVector', value: queryVector }
  ];
  applyIngestionFilter(conditions, parameters, ingestionId);

  if (Array.isArray(filters.productIds) && filters.productIds.length) {
    conditions.push(`(
      ARRAY_CONTAINS(@productIds, LOWER(c.productId))
      OR EXISTS (SELECT VALUE p FROM p IN c.normalizedProductIds WHERE ARRAY_CONTAINS(@productIds, p))
      OR EXISTS (SELECT VALUE a FROM a IN c.normalizedAlternateProductIds WHERE ARRAY_CONTAINS(@productIds, a))
    )`);
    const productIds = filters.productIds.map(normalizeFilterValue);
    addParameter(parameters, '@productIds', productIds);
  }

  if (filters.productName) {
    conditions.push(`(
      CONTAINS(c.normalizedProductName, @productName)
      OR EXISTS (SELECT VALUE n FROM n IN c.normalizedProductNames WHERE CONTAINS(n, @productName))
      OR CONTAINS(LOWER(c.productId), @productName)
      OR ARRAY_CONTAINS(c.normalizedAlternateProductIds, @productName)
      OR ARRAY_CONTAINS(c.normalizedModelIds, @productName)
    )`);
    addParameter(parameters, '@productName', normalizeFilterValue(filters.productName));
  }
  if (filters.category) {
    conditions.push('c.category = @category');
    addParameter(parameters, '@category', normalizeFilterValue(filters.category));
  }
  if (filters.manufacturerBrand) {
    conditions.push('c.normalizedManufacturerBrand = @manufacturerBrand');
    addParameter(parameters, '@manufacturerBrand', normalizeFilterValue(filters.manufacturerBrand));
  }
  if (filters.material) {
    conditions.push('ARRAY_CONTAINS(c.materials, @material)');
    addParameter(parameters, '@material', normalizeMaterialValue(filters.material));
  }
  if (filters.color) {
    conditions.push('ARRAY_CONTAINS(c.colors, @color)');
    addParameter(parameters, '@color', normalizeFilterValue(filters.color));
  }
  if (filters.productUse) {
    conditions.push('(c.productUse = @productUse OR ARRAY_CONTAINS(c.useCases, @productUse))');
    addParameter(parameters, '@productUse', normalizeFilterValue(filters.productUse));
  }
  if (filters.ingredient) {
    conditions.push('ARRAY_CONTAINS(c.ingredientNames, @ingredient)');
    addParameter(parameters, '@ingredient', normalizeFilterValue(filters.ingredient));
  }
  if (Array.isArray(filters.documentScopes) && filters.documentScopes.length) {
    conditions.push('ARRAY_CONTAINS(@documentScopes, c.documentScope)');
    addParameter(parameters, '@documentScopes', filters.documentScopes);
  }
  if (Array.isArray(filters.documentTypes) && filters.documentTypes.length) {
    conditions.push('ARRAY_CONTAINS(@documentTypes, c.documentType)');
    addParameter(parameters, '@documentTypes', filters.documentTypes);
  }

  return {
    query: `SELECT TOP ${topK} c.id, c.documentId, c.documentType, c.documentRole, c.documentScope, c.sourceName, c.sourcePath, c.productId, c.productIds, c.alternateProductIds, c.modelIds, c.productName, c.productNames, c.manufacturerBrand, c.sectionNumber, c.sectionTitle, c.pageStart, c.pageEnd, c.chunkIndex, c.content, VectorDistance(c.embedding, @queryVector) AS distance FROM c WHERE ${conditions.join(' AND ')} ORDER BY VectorDistance(c.embedding, @queryVector)`,
    parameters
  };
}

/**
 * Build the existing brand and knowledge-revision scoped catalog summary query.
 * @param {string} brandKey - Canonical support-brand key and knowledge partition.
 * @param {string} ingestionId - Knowledge revision identity.
 * @returns {Object} Cosmos query text and parameters.
 */
export function buildCatalogSummaryQuery(brandKey, ingestionId = null) {
  const conditions = ['c.brandKey = @brandKey', 'c.recordType = "product"', 'c.status = "active"'];
  const parameters = [{ name: '@brandKey', value: brandKey }];
  applyIngestionFilter(conditions, parameters, ingestionId);

  return {
    query: `SELECT c.category, COUNT(1) AS productCount FROM c
      WHERE ${conditions.join(' AND ')}
      GROUP BY c.category`,
    parameters
  };
}

/**
 * Build the existing manufacturer grouping query for the selected brand revision.
 * @param {string} brandKey - Canonical support-brand key and knowledge partition.
 * @param {string} ingestionId - Knowledge revision identity.
 * @returns {Object} Cosmos query text and parameters.
 */
export function buildManufacturerSummaryQuery(brandKey, ingestionId = null) {
  const conditions = ['c.brandKey = @brandKey', 'c.recordType = "product"', 'c.status = "active"'];
  const parameters = [{ name: '@brandKey', value: brandKey }];
  applyIngestionFilter(conditions, parameters, ingestionId);

  return {
    query: `SELECT c.manufacturerBrand, COUNT(1) AS productCount FROM c
      WHERE ${conditions.join(' AND ')}
      GROUP BY c.manufacturerBrand`,
    parameters
  };
}
