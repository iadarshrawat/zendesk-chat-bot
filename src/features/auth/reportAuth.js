import { timingSafeEqual } from "node:crypto";

const BEARER_TOKEN_PATTERN = /^Bearer (\S+)$/i;

export function requireReportKey(req, res, next) {
  const configuredKey = process.env.REPORT_API_KEY;
  if (!configuredKey) {
    return res.status(503).json({ error: "Report access is not configured" });
  }

  const authorizationHeader = req.get("authorization") || "";
  const receivedKey = BEARER_TOKEN_PATTERN.exec(authorizationHeader)?.[1] || "";
  const receivedBuffer = Buffer.from(receivedKey);
  const configuredBuffer = Buffer.from(configuredKey);

  const keysHaveSameLength = receivedBuffer.length === configuredBuffer.length;
  const keyMatches = keysHaveSameLength && timingSafeEqual(receivedBuffer, configuredBuffer);

  if (!keyMatches) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}
