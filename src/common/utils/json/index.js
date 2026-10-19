/**
 * Parse model JSON using the existing code-fence and object-extraction fallback rules.
 * @param {string} text - Text to normalize or inspect.
 * @returns {Object} The parsed JSON object; throws for an invalid response.
 */
export function parseJsonObject(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  const objectStart = cleaned.indexOf('{');
  const objectEnd = cleaned.lastIndexOf('}');
  if (objectStart < 0 || objectEnd <= objectStart) {
    throw new Error('Expected a JSON object');
  }

  const value = JSON.parse(cleaned.slice(objectStart, objectEnd + 1));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }

  return value;
}
/**
 * Serialize JSON data with stable object keys; array order and original values stay intact.
 * @param {*} value - JSON-compatible data used by evidence fingerprints and cache keys.
 * @returns {string} Deterministic JSON text.
 */
export function stableStringify(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map(key => [key, item[key]])
        )
      : item
  );
}
