import { createHash } from 'node:crypto';

// Formatting aliases only: never infer a source from a filename, product ID,
// similarity, neighbouring number, or another brand's evidence.
/**
 * Recognize and normalize only the existing product, source, and catalog evidence label formats.
 * @param {*} value - Input value being inspected or normalized.
 * @returns {string|null} The canonical label, or null for an unsupported label.
 */
function canonicalEvidenceLabel(value) {
  if (typeof value !== 'string' || value.length > 120) {
    return null;
  }

  let label = value.trim().toUpperCase();
  const hasSquareBrackets = label.startsWith('[') && label.endsWith(']');
  const hasParentheses = label.startsWith('(') && label.endsWith(')');
  if (hasSquareBrackets || hasParentheses) {
    label = label.slice(1, -1).trim();
  }

  if (/^CATALOG[\s_-]+SUMMARY$/.test(label)) {
    return 'CATALOG SUMMARY';
  }

  const match = /^(PRODUCT|SOURCE)(?:\s*[:#_]\s*|\s+|-)?(\d{1,9})$/.exec(label);
  const number = match ? Number(match[2]) : 0;

  return number > 0 ? `${match[1]} ${number}` : null;
}

/**
 * Collect the labels supplied by the current retrieval result.
 * @param {Object} rag - Current retrieval result and allowed evidence labels.
 * @returns {Array<string>} Valid labels available for answer citations.
 */
export function allowedEvidenceLabels(rag) {
  const labels = (rag.sources || []).map(source => canonicalEvidenceLabel(source.label)).filter(Boolean);

  return [...new Set(labels)];
}

/**
 * Resolve supplied citation values against only the current retrieval labels.
 * @param {Array} values - Values or labels to normalize.
 * @param {Object} rag - Current retrieval result and allowed evidence labels.
 * @returns {Object} Accepted source labels and the existing validation diagnostics.
 */
export function resolveEvidenceLabels(values, rag) {
  const allowed = allowedEvidenceLabels(rag);
  const allowedSet = new Set(allowed);
  const supplied = Array.isArray(values) ? [...new Set(values)] : [];
  const accepted = [];
  const rejected = [];
  let normalizedCount = 0;

  for (const value of supplied) {
    const canonical = canonicalEvidenceLabel(value);
    if (!canonical || !allowedSet.has(canonical)) {
      rejected.push(value);
      continue;
    }

    if (value !== canonical) {
      normalizedCount += 1;
    }
    if (!accepted.includes(canonical)) {
      accepted.push(canonical);
    }
  }

  return { allowed, accepted, rejected, normalizedCount };
}

// Unknown labels can contain customer text or credentials. Log a digest, not
// that text. Known grammar is safe and useful even when the number is invalid.
/**
 * Summarize citation-label problems without exposing customer text or unknown label contents.
 * @param {Array} values - Values or labels to normalize.
 * @param {number} limit - Existing maximum number of values or characters.
 * @returns {Array<string>} Canonical labels or safe digests for unsupported label values.
 */
export function safeLabelDiagnostics(values, limit = 12) {
  const labels = Array.isArray(values) ? values : [];

  return labels.slice(0, Math.min(12, limit)).map(value => {
    const canonical = canonicalEvidenceLabel(value);
    if (canonical) {
      return canonical;
    }

    const serialized = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
    const digest = createHash('sha256').update(serialized).digest('hex').slice(0, 12);

    return `UNRECOGNIZED ${digest}`;
  });
}
