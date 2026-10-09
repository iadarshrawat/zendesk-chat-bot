import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  fetchConversationMessages,
  passConversationControl,
  postConversationActivity,
  postConversationMessage,
  markDeliveryUncertain
} from '../../src/api/sunshine/conversations.js';
import { createClaudeMessage } from '../../src/api/anthropic/messages.js';
import { fetchConversationEvents } from '../../src/api/zendesk/conversations.js';
import { withZendeskRateLimitRetry } from '../../src/api/zendesk/client.js';

test('Sunshine requests keep message bodies, paths, and cancellation settings', async () => {
  const savedAppId = process.env.SUNSHINE_APP_ID;
  process.env.SUNSHINE_APP_ID = 'test-app';
  const requests = [];
  const client = axios.create({
    timeout: 15_000,
    adapter: async config => {
      requests.push(config);

      return { data: { accepted: true }, status: 200, headers: {}, config };
    }
  });
  const signal = new AbortController().signal;
  const message = {
    author: { type: 'business' },
    content: { type: 'text', text: 'Your order is on its way.' }
  };
  const form = {
    author: { type: 'business' },
    content: { type: 'form', fields: [{ name: 'email', type: 'email' }] }
  };
  const metadata = { 'dataCapture.systemField.email': 'customer@example.com' };

  try {
    const result = await postConversationMessage(client, 'conversation-1', message);
    assert.deepEqual(result.data, { accepted: true });
    await postConversationMessage(client, 'conversation-1', form, [{ timeout: 2_000 }]);
    await postConversationActivity(
      client,
      'conversation-1',
      { author: { type: 'business' }, type: 'typing:start' },
      { signal, timeoutMs: 1_000 }
    );
    await postConversationActivity(client, 'conversation-1', { author: { type: 'business' }, type: 'typing:stop' }, {});
    await fetchConversationMessages(client, 'conversation-1', {
      signal,
      timeoutMs: 3_000
    });
    await passConversationControl(client, 'conversation-1', metadata);

    const base = '/apps/test-app/conversations/conversation-1';
    assert.deepEqual(
      requests.map(({ method, url }) => [method, url]),
      [
        ['post', `${base}/messages`],
        ['post', `${base}/messages`],
        ['post', `${base}/activity`],
        ['post', `${base}/activity`],
        ['get', `${base}/messages`],
        ['post', `${base}/passControl`]
      ]
    );
    assert.deepEqual(JSON.parse(requests[0].data), message);
    assert.deepEqual(JSON.parse(requests[1].data), form);
    assert.equal(JSON.parse(requests[2].data).type, 'typing:start');
    assert.equal(JSON.parse(requests[3].data).type, 'typing:stop');
    assert.deepEqual(JSON.parse(requests[5].data), {
      switchboardIntegration: 'zd-agentWorkspace',
      metadata
    });
    assert.deepEqual(
      requests.map(({ timeout }) => timeout),
      [15_000, 2_000, 1_000, 15_000, 3_000, 15_000]
    );
    assert.equal(requests[2].signal, signal);
    assert.equal(requests[4].signal, signal);
    assert.equal(requests[0].signal, undefined);
  } finally {
    if (savedAppId === undefined) {
      delete process.env.SUNSHINE_APP_ID;
    } else {
      process.env.SUNSHINE_APP_ID = savedAppId;
    }
  }
});

test('message failures retain the delivery-uncertain classification', () => {
  for (const [status, expected] of [
    [undefined, true],
    [400, false],
    [429, false],
    [503, true]
  ]) {
    const error = new Error('Delivery failed');
    if (status !== undefined) {
      error.response = { status };
    }
    markDeliveryUncertain(error);
    assert.equal(error.deliveryUncertain, expected);
    assert.equal(error.message, 'Delivery failed');
  }
});

test('Claude requests preserve prompts, retry limits, and deadlines', async () => {
  const calls = [];
  const response = { content: [{ type: 'text', text: 'Answer' }] };
  const client = {
    messages: {
      create: async (...args) => {
        calls.push(args);

        return response;
      }
    }
  };
  const payload = {
    model: 'test-model',
    system: 'Use only supplied evidence.',
    messages: [{ role: 'user', content: 'Order status?' }],
    max_tokens: 500
  };
  const signal = new AbortController().signal;
  assert.equal(
    await createClaudeMessage(client, payload, {
      timeoutMs: 5_000,
      maxRetries: 0,
      signal
    }),
    response
  );
  await createClaudeMessage(client, payload, {
    timeoutMs: 10_000,
    maxRetries: 1
  });
  assert.deepEqual(calls, [
    [payload, { timeout: 5_000, maxRetries: 0, signal }],
    [payload, { timeout: 10_000, maxRetries: 1 }]
  ]);
});

test('Zendesk conversation history follows cursors without losing event order', async () => {
  const calls = [];
  const pages = [
    {
      events: [{ id: 'first' }],
      meta: { has_more: true, after_cursor: 'page-2' }
    },
    { events: [{ id: 'second' }], meta: { has_more: false } }
  ];
  const client = {
    get: async (...args) => {
      calls.push(args);

      return { data: pages[calls.length - 1] };
    }
  };
  assert.deepEqual(await fetchConversationEvents(client, 123), [{ id: 'first' }, { id: 'second' }]);
  assert.deepEqual(calls, [
    ['/tickets/123/conversation_log', { params: { sort: 'created_at', 'page[size]': 100 } }],
    [
      '/tickets/123/conversation_log',
      {
        params: {
          sort: 'created_at',
          'page[size]': 100,
          'page[after]': 'page-2'
        }
      }
    ]
  ]);
});

test('Zendesk conversation history rejects a stalled cursor', async () => {
  let calls = 0;
  const client = {
    get: async () => {
      calls += 1;

      return {
        data: {
          events: [],
          meta: { has_more: true, after_cursor: 'same-page' }
        }
      };
    }
  };
  await assert.rejects(fetchConversationEvents(client, 123), /cursor stalled for ticket 123/);
  assert.equal(calls, 2);
});

test('monitoring retries only rate limits and keeps the four-attempt cap', async () => {
  const rateLimit = Object.assign(new Error('Rate limited'), {
    response: { status: 429, headers: { 'retry-after': '0.001' } }
  });
  let attempts = 0;
  await assert.rejects(
    withZendeskRateLimitRetry(async () => {
      attempts += 1;
      throw rateLimit;
    }),
    error => error === rateLimit
  );
  assert.equal(attempts, 4);

  const serverError = Object.assign(new Error('Provider unavailable'), {
    response: { status: 503 }
  });
  attempts = 0;
  await assert.rejects(
    withZendeskRateLimitRetry(async () => {
      attempts += 1;
      throw serverError;
    }),
    error => error === serverError
  );
  assert.equal(attempts, 1);
});
