import { timingSafeEqual } from 'node:crypto';

export function bearerToken(authorizationHeader) {
  return /^Bearer (\S+)$/i.exec(authorizationHeader || '')?.[1];
}

/**
 * Compare configured shared secrets without leaking the matching prefix.
 * @param {string} received - Incoming API or webhook key.
 * @param {string} expected - Configured secret.
 * @returns {boolean} True only for keys of equal byte length and value.
 */
export function secretsMatch(received, expected) {
  const receivedBuffer = Buffer.from(received || '');
  const expectedBuffer = Buffer.from(expected);

  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

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
 * Wait between background retries without borrowing a customer response budget.
 * @param {number} milliseconds - Delay before resolving.
 * @returns {Promise<void>} Resolves after the existing timer delay.
 */
export function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
