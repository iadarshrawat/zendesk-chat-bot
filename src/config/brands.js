import dotenv from "dotenv";
import { normalizeKnowledgeKey } from "../features/knowledge/knowledge.js";

dotenv.config();

function compactStrings(values) {
  const nonEmptyValues = values
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return [...new Set(nonEmptyValues)];
}

function buildBrand({ key, displayName, aliases = [], widgetIds = [], widgetEnvName }) {
  return Object.freeze({
    key,
    displayName,
    widgetEnvName,
    aliases: compactStrings([key, displayName, ...aliases]),
    widgetIds: compactStrings(widgetIds),
  });
}

/**
 * Canonical support brands. Product manufacturer/label names belong to product
 * metadata and must never be used to change the Zendesk conversation's brand
 * partition.
 */
export const SUPPORT_BRANDS = Object.freeze([
  buildBrand({
    key: "mr-brand",
    displayName: process.env.SUPPORT_NAME_MR_BRAND?.trim() || "Mr Brand",
    aliases: ["Mr. Brand", "Mr Brands", "Mr. Brands", "Mr. Brands LLC"],
    widgetIds: [process.env.WIDGET_ID_MR_BRAND],
    widgetEnvName: "WIDGET_ID_MR_BRAND",
  }),
  buildBrand({
    key: "comfort-zone",
    displayName: process.env.SUPPORT_NAME_COMFORT_ZONE?.trim() || "Comfort Zone",
    aliases: ["ComfortZone", "Comfort Zone Products"],
    widgetIds: [process.env.WIDGET_ID_COMFORT_ZONE],
    widgetEnvName: "WIDGET_ID_COMFORT_ZONE",
  }),
]);

export function resolveSupportBrand(value) {
  const key = normalizeKnowledgeKey(value, "");
  if (!key) return null;

  return SUPPORT_BRANDS.find((brand) =>
    brand.key === key || brand.aliases.some((alias) => normalizeKnowledgeKey(alias, "") === key),
  ) || null;
}

export function requireSupportBrand(value) {
  const brand = resolveSupportBrand(value);
  if (!brand) {
    const expectedBrands = SUPPORT_BRANDS.map((item) => item.key).join(", ");
    throw new Error(
      `Unknown support brand: ${value || "(empty)"}. Expected one of: ${expectedBrands}`,
    );
  }
  return brand;
}

export function getSupportBrandByWidgetId(widgetId) {
  const normalizedId = String(widgetId || "").trim();
  const matched = normalizedId
    ? SUPPORT_BRANDS.find((brand) => brand.widgetIds.includes(normalizedId))
    : null;
  if (matched) return matched;

  const error = new Error(
    normalizedId
      ? `Unmapped Zendesk conversation brandId: ${normalizedId}`
      : "Zendesk conversation has no brandId",
  );
  error.code = "SUPPORT_BRAND_NOT_CONFIGURED";
  throw error;
}

export function getBrandRoutingConfigurationErrors() {
  const errors = SUPPORT_BRANDS
    .filter((brand) => brand.widgetIds.length === 0)
    .map((brand) => `${brand.widgetEnvName} is missing`);
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

export function assertBrandRoutingConfigured() {
  const errors = getBrandRoutingConfigurationErrors();
  if (errors.length) {
    const error = new Error(`Support-brand routing is invalid: ${errors.join("; ")}`);
    error.code = "SUPPORT_BRAND_ROUTING_INVALID";
    throw error;
  }
}
