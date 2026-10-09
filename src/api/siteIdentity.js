import { createPublicKey } from 'node:crypto';

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const JWKS_REQUEST_TIMEOUT_MS = 3000;

let jwksCache = { expiresAt: 0, keys: [] };

/**
 * Load and cache website signing keys, then select the RSA key for a token header.
 * @param {string} keyId - Website JWT key ID to find in the JWKS response.
 * @returns {Promise<Object>} The matching public key; rejects for missing or unavailable keys.
 */
export async function getPublicKey(keyId) {
  const url = process.env.WEBSITE_SESSION_JWKS_URL;
  if (!url || !url.startsWith('https://')) {
    throw new Error('Website identity is not configured');
  }

  if (Date.now() >= jwksCache.expiresAt) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(JWKS_REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new Error('Website identity keys unavailable');
    }

    const body = await response.json();
    jwksCache = {
      keys: Array.isArray(body.keys) ? body.keys : [],
      expiresAt: Date.now() + JWKS_CACHE_TTL_MS
    };
  }

  const key = jwksCache.keys.find(
    item => item.kid === keyId && item.kty === 'RSA' && (!item.use || item.use === 'sig') && (!item.alg || item.alg === 'RS256')
  );

  if (!key) {
    throw new Error('Website identity key not found');
  }

  return createPublicKey({ key, format: 'jwk' });
}
