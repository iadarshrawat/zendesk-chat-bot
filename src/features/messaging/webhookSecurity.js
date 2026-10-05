import { timingSafeEqual } from "node:crypto";

export function verifySunshineWebhook(req, res, next) {
  const expectedApiKey = process.env.SUNSHINE_WEBHOOK_SECRET;
  const providedApiKey = req.get("x-api-key");

  if (!expectedApiKey) {
    return res.status(503).json({ error: "Webhook is not configured" });
  }

  const providedKeyBuffer = Buffer.from(providedApiKey || "");
  const expectedKeyBuffer = Buffer.from(expectedApiKey);
  const keysHaveDifferentLengths = providedKeyBuffer.length !== expectedKeyBuffer.length;

  if (keysHaveDifferentLengths || !timingSafeEqual(providedKeyBuffer, expectedKeyBuffer)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.body?.app?.id !== process.env.SUNSHINE_APP_ID) {
    return res.status(400).json({ error: "Unexpected app" });
  }

  next();
}
