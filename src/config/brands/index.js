import 'dotenv/config';
import { normalizeKnowledgeKey } from '../../common/rag/normalization/index.js';

function compactStrings(values) {
  const nonEmptyValues = values.map(value => String(value || '').trim()).filter(Boolean);

  return [...new Set(nonEmptyValues)];
}

/**
 * Build an immutable brand definition with unique aliases and widget IDs.
 * @param {Object} options - Brand key, display name, aliases, widget IDs, and environment name.
 * @returns {Object} The normalized brand definition.
 */
function buildBrand({ key, displayName, aliases = [], widgetIds = [], widgetEnvName, instructions = '' }) {
  return Object.freeze({
    key,
    displayName,
    widgetEnvName,
    instructions,
    aliases: compactStrings([key, displayName, ...aliases]),
    widgetIds: compactStrings(widgetIds)
  });
}

/**
 * Canonical support brands. Product manufacturer/label names belong to product
 * metadata and must never be used to change the Zendesk conversation's brand
 * partition.
 */
const LEGACY_BRANDS = [
  buildBrand({
    key: 'mr-brand',
    displayName: process.env.SUPPORT_NAME_MR_BRAND?.trim() || 'Mr Brand',
    aliases: ['Mr. Brand', 'Mr Brands', 'Mr. Brands', 'Mr. Brands LLC'],
    widgetIds: [process.env.WIDGET_ID_MR_BRAND],
    widgetEnvName: 'WIDGET_ID_MR_BRAND'
  }),
  buildBrand({
    key: 'comfort-zone',
    displayName: process.env.SUPPORT_NAME_COMFORT_ZONE?.trim() || 'Comfort Zone',
    aliases: ['ComfortZone', 'Comfort Zone Products'],
    widgetIds: [process.env.WIDGET_ID_COMFORT_ZONE],
    widgetEnvName: 'WIDGET_ID_COMFORT_ZONE'
  })
];

/**
 * Load optional tenant routing and business instructions, preserving legacy environment settings when absent.
 * @returns {Array<Object>} Validated immutable brands; malformed or ambiguous configuration fails startup.
 */
function configuredBrands() {
  if (!process.env.SUPPORT_BRANDS_JSON?.trim()) return LEGACY_BRANDS;
  let brands;
  try {
    brands = JSON.parse(process.env.SUPPORT_BRANDS_JSON);
  } catch {
    throw new Error('SUPPORT_BRANDS_JSON must be a valid JSON array');
  }
  if (!Array.isArray(brands) || !brands.length) throw new Error('SUPPORT_BRANDS_JSON requires at least one brand');
  return brands.map(brand => {
    if (
      !brand ||
      typeof brand.key !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(brand.key) ||
      typeof brand.displayName !== 'string' ||
      !brand.displayName.trim() ||
      !Array.isArray(brand.widgetIds) ||
      !brand.widgetIds.length ||
      !brand.widgetIds.every(id => typeof id === 'string' && id.trim()) ||
      (brand.aliases != null && (!Array.isArray(brand.aliases) || !brand.aliases.every(alias => typeof alias === 'string'))) ||
      (brand.instructions != null && typeof brand.instructions !== 'string')
    ) {
      throw new Error('Each configured brand requires a canonical key, displayName, widgetIds and optional aliases/instructions');
    }
    return buildBrand({ ...brand, displayName: brand.displayName.trim(), widgetEnvName: `SUPPORT_BRANDS_JSON (${brand.key})` });
  });
}

const SUPPORT_BRANDS = Object.freeze(configuredBrands());

/**
 * Resolve an existing brand name or key against the configured support brands.
 * @param {*} value - Input value being inspected or normalized.
 * @returns {Object|null} The matching support brand, or null.
 */
export function resolveSupportBrand(value) {
  const key = normalizeKnowledgeKey(value, '');
  if (!key) {
    return null;
  }

  return SUPPORT_BRANDS.find(brand => brand.key === key || brand.aliases.some(alias => normalizeKnowledgeKey(alias, '') === key)) || null;
}

/**
 * Return the configured tenant's business instructions, falling back to shared context.
 * @param {string} brand - Canonical tenant key, display name or configured alias.
 * @returns {string} Business context used by planning and answer prompts.
 */
export function getSupportContext(brand) {
  return resolveSupportBrand(brand)?.instructions?.trim() || process.env.BOT_CONTEXT?.trim() || '';
}

/**
 * Resolve a support brand and reject an unknown or missing brand identifier.
 * @param {*} value - Input value being inspected or normalized.
 * @returns {Object} The configured support brand; throws if it cannot be resolved.
 */
export function requireSupportBrand(value) {
  const brand = resolveSupportBrand(value);
  if (!brand) {
    const expectedBrands = SUPPORT_BRANDS.map(item => item.key).join(', ');
    throw new Error(`Unknown support brand: ${value || '(empty)'}. Expected one of: ${expectedBrands}`);
  }

  return brand;
}

/**
 * Resolve the support brand for a configured Zendesk widget ID.
 * @param {string} widgetId - Zendesk widget ID used for brand routing.
 * @returns {Object} The configured support brand; throws for unknown or ambiguous routing.
 */
export function getSupportBrandByWidgetId(widgetId) {
  const normalizedId = String(widgetId || '').trim();
  const matched = normalizedId ? SUPPORT_BRANDS.find(brand => brand.widgetIds.includes(normalizedId)) : null;
  if (matched) {
    return matched;
  }

  const error = new Error(normalizedId ? `Unmapped Zendesk conversation brandId: ${normalizedId}` : 'Zendesk conversation has no brandId');
  error.code = 'SUPPORT_BRAND_NOT_CONFIGURED';
  throw error;
}

/**
 * Find missing or conflicting widget IDs in the existing brand routing configuration.
 * @returns {Array<string>} Configuration errors that prevent reliable brand routing.
 */
function getBrandRoutingConfigurationErrors() {
  const errors = SUPPORT_BRANDS.filter(brand => brand.widgetIds.length === 0).map(brand => `${brand.widgetEnvName} is missing`);
  const owners = new Map();
  const aliasOwners = new Map();

  for (const brand of SUPPORT_BRANDS) {
    for (const alias of brand.aliases) {
      const name = normalizeKnowledgeKey(alias, '');
      if (aliasOwners.has(name) && aliasOwners.get(name) !== brand) errors.push('Support brand keys/names/aliases must be unique');
      aliasOwners.set(name, brand);
    }
    for (const widgetId of brand.widgetIds) {
      const existing = owners.get(widgetId);
      if (existing && existing !== brand.key) {
        errors.push(`Widget ID ${widgetId} is assigned to both ${existing} and ${brand.key}`);
      }
      owners.set(widgetId, brand.key);
    }
  }

  return errors;
}

/**
 * Stop startup when support-brand routing is missing or ambiguous.
 * @returns {void} Returns normally for valid routing; otherwise throws the configuration error.
 */
export function assertBrandRoutingConfigured() {
  const errors = getBrandRoutingConfigurationErrors();
  if (errors.length) {
    const error = new Error(`Support-brand routing is invalid: ${errors.join('; ')}`);
    error.code = 'SUPPORT_BRAND_ROUTING_INVALID';
    throw error;
  }
}
