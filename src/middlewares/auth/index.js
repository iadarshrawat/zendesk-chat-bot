import jwt from 'jsonwebtoken';
import { getPublicKey } from '../../api/siteIdentity.js';
import { bearerToken } from '../../common/utils/index.js';

/**
 * Verify the website session's signature, issuer, audience, and customer identity before widget authentication.
 * @param {Object} req - Express request.
 * @param {Object} res - Express response.
 * @param {Function} next - Express continuation callback.
 * @returns {Promise<void>} Sets req.siteUser and calls next, or sends the existing identity error.
 */
export async function requireSiteIdentity(req, res, next) {
  const identityIsConfigured =
    process.env.WEBSITE_SESSION_JWKS_URL && process.env.WEBSITE_SESSION_ISSUER && process.env.WEBSITE_SESSION_AUDIENCE;

  if (!identityIsConfigured) {
    return res.status(503).json({ error: 'Website identity is not configured' });
  }

  const authorizationHeader = req.get('authorization') || '';
  const token = bearerToken(authorizationHeader);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const header = jwt.decode(token, { complete: true })?.header;
    if (header?.alg !== 'RS256' || !header.kid) {
      throw new Error('Invalid token header');
    }

    const key = await getPublicKey(header.kid);
    const claims = jwt.verify(token, key, {
      algorithms: ['RS256'],
      issuer: process.env.WEBSITE_SESSION_ISSUER,
      audience: process.env.WEBSITE_SESSION_AUDIENCE
    });

    if (!claims.sub || typeof claims.sub !== 'string' || claims.sub.length > 255) {
      throw new Error('Invalid user identity');
    }

    req.siteUser = claims;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid website session' });
  }
}
