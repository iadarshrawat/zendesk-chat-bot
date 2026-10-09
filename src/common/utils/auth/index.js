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
