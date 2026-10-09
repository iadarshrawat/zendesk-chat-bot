import dotenv from 'dotenv';
import { normalizeKnowledgeKey } from '../common/rag/index.js';

dotenv.config();

function compactStrings(values) {
  const nonEmptyValues = values.map(value => String(value || '').trim()).filter(Boolean);

  return [...new Set(nonEmptyValues)];
}

/**
 * Build an immutable brand definition with unique aliases and widget IDs.
 * @param {Object} options - Brand key, display name, aliases, widget IDs, and environment name.
 * @returns {Object} The normalized brand definition.
 */
function buildBrand({ key, displayName, aliases = [], widgetIds = [], widgetEnvName }) {
  return Object.freeze({
    key,
    displayName,
    widgetEnvName,
    aliases: compactStrings([key, displayName, ...aliases]),
    widgetIds: compactStrings(widgetIds)
  });
}

/**
 * Canonical support brands. Product manufacturer/label names belong to product
 * metadata and must never be used to change the Zendesk conversation's brand
 * partition.
 */
const SUPPORT_BRANDS = Object.freeze([
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
]);

/**
 * Resolve an existing brand name or key against the configured support brands.
 * @param {*} value - Input value being inspected or normalized.
 * @returns {Object|null} The matching support brand, or null.
 */
function resolveSupportBrand(value) {
  const key = normalizeKnowledgeKey(value, '');
  if (!key) {
    return null;
  }

  return SUPPORT_BRANDS.find(brand => brand.key === key || brand.aliases.some(alias => normalizeKnowledgeKey(alias, '') === key)) || null;
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

  for (const brand of SUPPORT_BRANDS) {
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
