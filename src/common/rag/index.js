import { createHash } from 'node:crypto';

/**
 * Normalize a brand or knowledge identity into the existing stable key format.
 * @param {*} value - Input value being inspected or normalized.
 * @param {*} fallback - Existing default when the input is missing.
 * @returns {string} The normalized key or supplied fallback.
 */
export function normalizeKnowledgeKey(value, fallback = 'default') {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
}

/**
 * Normalize a catalog filter's whitespace and case using the existing matching rules.
 * @param {*} value - Input value being inspected or normalized.
 * @returns {string} The normalized filter value.
 */
export function normalizeFilterValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Normalize filter values, remove empty entries, and keep unique strings.
 * @param {*} values - A list of values or a single value to normalize.
 * @returns {Array<string>} Unique normalized filter strings.
 */
export function normalizeStringArray(values) {
  const input = Array.isArray(values) ? values : values ? [values] : [];
  const normalizedValues = input.map(normalizeFilterValue).filter(Boolean);

  return [...new Set(normalizedValues)];
}

/**
 * Normalize the existing material aliases used by structured product search.
 * @param {*} value - Input value being inspected or normalized.
 * @returns {string} The canonical material value.
 */
export function normalizeMaterialValue(value) {
  let material = normalizeFilterValue(value);
  if (material === 'aluminum') {
    material = 'aluminium';
  }
  if (material.endsWith(' metal') && material !== 'metal') {
    material = material.slice(0, -' metal'.length).trim();
  }

  return material;
}

/**
 * Hash identity parts into the existing deterministic 40-character knowledge record ID.
 * @param {...*} parts - Identity values combined into the record hash.
 * @returns {string} The stable record ID.
 */
export function createStableId(...parts) {
  return createHash('sha256')
    .update(parts.map(part => String(part ?? '')).join('|'))
    .digest('hex')
    .slice(0, 40);
}
