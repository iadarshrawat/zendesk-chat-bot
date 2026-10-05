import test from "node:test";
import assert from "node:assert/strict";
import { createSunshineClient } from "./sunshine.js";

test("Sunshine Conversations calls preserve the working API endpoint", () => {
  const environmentNames = [
    "SUNSHINE_KEY_ID",
    "SUNSHINE_KEY_SECRET",
    "SUNSHINE_APP_ID",
    "ZENDESK_SUBDOMAIN",
  ];
  const savedEnvironment = Object.fromEntries(
    environmentNames.map(name => [name, process.env[name]]),
  );

  try {
    process.env.SUNSHINE_KEY_ID = "test-key";
    process.env.SUNSHINE_KEY_SECRET = "test-secret";
    process.env.SUNSHINE_APP_ID = "test-app";
    process.env.ZENDESK_SUBDOMAIN = "sample";

    const client = createSunshineClient();

    assert.equal(client.defaults.baseURL, "https://api.smooch.io/v2");
    assert.equal(client.defaults.auth.username, "test-key");
  } finally {
    for (const name of environmentNames) {
      if (savedEnvironment[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = savedEnvironment[name];
      }
    }
  }
});
