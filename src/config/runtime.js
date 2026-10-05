import { assertBrandRoutingConfigured } from "./brands.js";
import { assertRagConfigured } from "./rag.js";

export function assertRuntimeConfiguration() {
  assertBrandRoutingConfigured();
  assertRagConfigured();

  const required = [
    "SUNSHINE_KEY_ID",
    "SUNSHINE_KEY_SECRET",
    "SUNSHINE_APP_ID",
    "SUNSHINE_WEBHOOK_SECRET",
    "ANTHROPIC_API_KEY",
    "ZENDESK_SUBDOMAIN",
    "ZENDESK_CLIENT_ID",
    "ZENDESK_CLIENT_SECRET",
    "ZENDESK_BUSINESS_HOURS_SCHEDULE_ID",
  ];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length) {
    throw new Error(`Missing configuration: ${missing.join(", ")}`);
  }
}
