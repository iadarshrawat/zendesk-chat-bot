import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/loaders/app/index.js';

async function startTestServer() {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`
  };
}

function stopTestServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function saveEnvironment(variableNames) {
  return Object.fromEntries(variableNames.map(name => [name, process.env[name]]));
}

function restoreEnvironment(savedEnvironment) {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

test('route extraction preserves origin checks, body limits, and parser errors', async () => {
  const savedEnvironment = saveEnvironment(['ALLOWED_ORIGINS']);
  process.env.ALLOWED_ORIGINS = 'https://trusted.example';
  const { server, baseUrl } = await startTestServer();

  try {
    const blocked = await fetch(`${baseUrl}/sunshine/auth`, {
      method: 'POST',
      headers: {
        Origin: 'https://untrusted.example',
        'Content-Type': 'application/json'
      },
      body: '{malformed'
    });
    assert.equal(blocked.status, 403);
    assert.deepEqual(await blocked.json(), { error: 'Origin not allowed' });

    const preflight = await fetch(`${baseUrl}/sunshine/auth`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://trusted.example',
        'Access-Control-Request-Method': 'POST'
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://trusted.example');

    for (const [path, body, status] of [
      ['/sunshine/auth', '{malformed', 400],
      ['/sunshine/auth', JSON.stringify({ padding: 'x'.repeat(1_024) }), 413],
      ['/sunshine/webhook', JSON.stringify({ padding: 'x'.repeat(256 * 1_024) }), 413]
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: 'Request failed' });
    }

    const readiness = await fetch(`${baseUrl}/health/ready`);
    assert.equal(readiness.status, 503);
    assert.deepEqual(await readiness.json(), { status: 'unavailable' });
  } finally {
    await stopTestServer(server);
    restoreEnvironment(savedEnvironment);
  }
});

test('identity, reports and webhooks reject untrusted requests', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const reportResponse = await fetch(`${baseUrl}/sunshine/report`);
    assert.ok([401, 503].includes(reportResponse.status));

    const monitoringResponse = await fetch(`${baseUrl}/sunshine/monitoring/sessions`);
    assert.ok([401, 503].includes(monitoringResponse.status));

    const issuesResponse = await fetch(`${baseUrl}/sunshine/monitoring/issues`);
    assert.ok([401, 503].includes(issuesResponse.status));

    const inboxResponse = await fetch(`${baseUrl}/sunshine/inbox`);
    assert.ok([401, 503].includes(inboxResponse.status));

    const authResponse = await fetch(`${baseUrl}/sunshine/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'victim',
        name: 'Victim',
        email: 'victim@example.com'
      })
    });
    assert.ok([401, 503].includes(authResponse.status));

    const webhookResponse = await fetch(`${baseUrl}/sunshine/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [] })
    });
    assert.ok([401, 503].includes(webhookResponse.status));

    const liveResponse = await fetch(`${baseUrl}/health/live`);
    assert.equal(liveResponse.status, 200);
  } finally {
    await stopTestServer(server);
  }
});

test('inbox diagnostics expose only counts to a report-key caller', async () => {
  const savedEnvironment = saveEnvironment(['REPORT_API_KEY']);
  process.env.REPORT_API_KEY = 'test-report-key';
  const { server, baseUrl } = await startTestServer();

  try {
    const response = await fetch(`${baseUrl}/sunshine/inbox`, {
      headers: { Authorization: 'Bearer test-report-key' }
    });
    assert.equal(response.status, 200);

    const snapshot = await response.json();
    assert.equal(typeof snapshot.counts.pending, 'number');
    assert.equal(typeof snapshot.active, 'number');
    assert.equal('payload' in snapshot, false);
  } finally {
    await stopTestServer(server);
    restoreEnvironment(savedEnvironment);
  }
});

test('widget JWT uses verified website claims and ignores forged request body', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048
  });
  const publicJwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'website-key',
    use: 'sig',
    alg: 'RS256'
  };
  const originalFetch = globalThis.fetch;
  const environmentNames = [
    'WEBSITE_SESSION_JWKS_URL',
    'WEBSITE_SESSION_ISSUER',
    'WEBSITE_SESSION_AUDIENCE',
    'ZENDESK_WIDGET_KEY_ID',
    'ZENDESK_WIDGET_JWT_SECRET'
  ];
  const savedEnvironment = saveEnvironment(environmentNames);

  Object.assign(process.env, {
    WEBSITE_SESSION_JWKS_URL: 'https://site.test/jwks',
    WEBSITE_SESSION_ISSUER: 'https://site.test/',
    WEBSITE_SESSION_AUDIENCE: 'zendesk-widget',
    ZENDESK_WIDGET_KEY_ID: 'zendesk-key',
    ZENDESK_WIDGET_JWT_SECRET: 'a-test-only-signing-secret'
  });

  globalThis.fetch = (input, options) => {
    if (input === 'https://site.test/jwks') {
      return Promise.resolve(new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }));
    }

    return originalFetch(input, options);
  };

  const { server, baseUrl } = await startTestServer();

  try {
    const websiteSession = jwt.sign(
      {
        sub: 'verified-customer',
        name: 'Real User',
        email: 'real@example.com',
        email_verified: true
      },
      privateKey,
      {
        algorithm: 'RS256',
        keyid: 'website-key',
        issuer: 'https://site.test/',
        audience: 'zendesk-widget',
        expiresIn: '5m'
      }
    );
    const response = await fetch(`${baseUrl}/sunshine/auth`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${websiteSession}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ id: 'forged-id', email: 'forged@example.com' })
    });

    assert.equal(response.status, 200);

    const { token } = await response.json();
    const claims = jwt.verify(token, process.env.ZENDESK_WIDGET_JWT_SECRET);

    assert.equal(claims.external_id, 'verified-customer');
    assert.equal(claims.email, 'real@example.com');
    assert.equal(claims.scope, 'user');
    assert.equal(jwt.decode(token, { complete: true }).header.kid, 'zendesk-key');
  } finally {
    await stopTestServer(server);
    globalThis.fetch = originalFetch;
    restoreEnvironment(savedEnvironment);
  }
});
