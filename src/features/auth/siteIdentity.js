import jwt from "jsonwebtoken";
import { createPublicKey } from "node:crypto";

const BEARER_TOKEN_PATTERN = /^Bearer (\S+)$/i;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const JWKS_REQUEST_TIMEOUT_MS = 3000;

let jwksCache = { expiresAt: 0, keys: [] };

async function getPublicKey(keyId) {
  const url = process.env.WEBSITE_SESSION_JWKS_URL;
  if (!url || !url.startsWith("https://")) {
    throw new Error("Website identity is not configured");
  }

  if (Date.now() >= jwksCache.expiresAt) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(JWKS_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error("Website identity keys unavailable");
    }

    const body = await response.json();
    jwksCache = {
      keys: Array.isArray(body.keys) ? body.keys : [],
      expiresAt: Date.now() + JWKS_CACHE_TTL_MS,
    };
  }

  const key = jwksCache.keys.find(item =>
    item.kid === keyId &&
    item.kty === "RSA" &&
    (!item.use || item.use === "sig") &&
    (!item.alg || item.alg === "RS256"));

  if (!key) {
    throw new Error("Website identity key not found");
  }

  return createPublicKey({ key, format: "jwk" });
}

export async function requireSiteIdentity(req, res, next) {
  const identityIsConfigured =
    process.env.WEBSITE_SESSION_JWKS_URL &&
    process.env.WEBSITE_SESSION_ISSUER &&
    process.env.WEBSITE_SESSION_AUDIENCE;

  if (!identityIsConfigured) {
    return res.status(503).json({ error: "Website identity is not configured" });
  }

  const authorizationHeader = req.get("authorization") || "";
  const token = BEARER_TOKEN_PATTERN.exec(authorizationHeader)?.[1];
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const header = jwt.decode(token, { complete: true })?.header;
    if (header?.alg !== "RS256" || !header.kid) {
      throw new Error("Invalid token header");
    }

    const key = await getPublicKey(header.kid);
    const claims = jwt.verify(token, key, {
      algorithms: ["RS256"],
      issuer: process.env.WEBSITE_SESSION_ISSUER,
      audience: process.env.WEBSITE_SESSION_AUDIENCE,
    });

    if (!claims.sub || typeof claims.sub !== "string" || claims.sub.length > 255) {
      throw new Error("Invalid user identity");
    }

    req.siteUser = claims;
    next();
  } catch {
    res.status(401).json({ error: "Invalid website session" });
  }
}
