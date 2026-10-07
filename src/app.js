import express from "express";
import cors from "cors";
import { handleSunshineMessage } from "./features/messaging/webhookController.js";
import { getInboxSnapshot } from "./features/messaging/inboxRepository.js";
import { verifySunshineWebhook } from "./features/messaging/webhookSecurity.js";
import { requireSiteIdentity } from "./features/auth/siteIdentity.js";
import { requireReportKey } from "./features/auth/reportAuth.js";
import { generateZendeskJWT } from "./features/auth/widgetAuth.js";
import { generateReport } from "./features/monitoring/reportController.js";
import { getPool } from "./config/sql.js";

function getAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function createOriginGuard(allowedOrigins) {
  return function requireAllowedOrigin(req, res, next) {
    const origin = req.get("origin");
    if (origin && !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: "Origin not allowed" });
    }

    next();
  };
}

async function readinessCheck(_req, res) {
  try {
    await getPool().request().query("SELECT 1 AS ok");
    res.json({ status: "ready" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
}

function handleRequestError(error, _req, res, _next) {
  console.error("HTTP request failed", { message: error.message });
  if (res.headersSent) return;

  let status = 500;
  if (error.type === "entity.too.large") {
    status = 413;
  } else if (error instanceof SyntaxError && "body" in error) {
    status = 400;
  }

  res.status(status).json({ error: "Request failed" });
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  const allowedOrigins = getAllowedOrigins();
  const requireAllowedOrigin = createOriginGuard(allowedOrigins);
  const widgetCors = cors({
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.includes(origin));
    },
  });

  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", readinessCheck);
  app.post(
    "/sunshine/webhook",
    express.json({ limit: "256kb" }),
    verifySunshineWebhook,
    handleSunshineMessage,
  );
  app.options("/sunshine/auth", requireAllowedOrigin, widgetCors);
  app.post(
    "/sunshine/auth",
    requireAllowedOrigin,
    widgetCors,
    express.json({ limit: "1kb" }),
    requireSiteIdentity,
    generateZendeskJWT,
  );
  app.get("/sunshine/report", requireReportKey, generateReport);
  app.get("/sunshine/monitoring/sessions", requireReportKey, generateReport);
  app.get("/sunshine/inbox", requireReportKey, (_req, res) => {
    res.json(getInboxSnapshot());
  });
  app.use(handleRequestError);

  return app;
}
