import test from 'node:test';
import assert from 'node:assert/strict';
import { previewTicketMonitoring } from '../../src/services/monitoring/index.js';

const START = Date.parse('2026-09-30T09:47:39Z');

function event(id, minutesAfterStart, author, text, source) {
  return {
    id,
    type: 'Messaging::ConversationMessage',
    created_at: new Date(START + minutesAfterStart * 60_000).toISOString(),
    author: { type: author },
    source,
    content: { text }
  };
}

function readOnlyTicketClient() {
  const calls = [];
  const ticket = {
    id: 5687,
    requester_id: 45783858625293,
    support_type: 'ai_agent',
    tags: [],
    updated_at: '2026-09-30T09:49:50Z'
  };
  const events = [
    event('customer-1', 0, 'user', 'Suggest a classroom fan'),
    event('bot-1', 1, 'system', 'Here are some options', {
      type: 'api:conversations'
    }),
    event('customer-2', 2, 'user', 'Are you there?'),
    event('bot-2', 3, 'system', 'Yes, I am here', {
      type: 'api:conversations'
    })
  ];

  return {
    calls,
    async get(path) {
      calls.push(path);
      if (path === '/tickets/5687') {
        return { data: { ticket } };
      }
      if (path === '/tickets/5687/conversation_log') {
        return { data: { events, meta: { has_more: false } } };
      }
      throw new Error(`Unexpected GET ${path}`);
    },
    async post() {
      throw new Error('Preview must not write to Zendesk');
    },
    async patch() {
      throw new Error('Preview must not write to Zendesk');
    }
  };
}

test('preview recognizes conversation API bot replies and scores before the two-hour wait', async () => {
  const client = readOnlyTicketClient();
  let evaluationCalls = 0;
  const evaluation = {
    customer_satisfaction: 'neutral',
    human_required: false,
    follow_up_required: false,
    confidence: 'medium',
    reason: 'The bot answered the request.',
    key_issue: null
  };

  const preview = await previewTicketMonitoring({
    ticketId: '5687',
    now: START + 4 * 60_000,
    client,
    evaluate: async ({ session, ticketMessages }) => {
      evaluationCalls++;
      assert.equal(session.messages.length, 4);
      assert.equal(ticketMessages.length, 4);

      return evaluation;
    }
  });

  assert.deepEqual(client.calls, ['/tickets/5687', '/tickets/5687/conversation_log']);
  assert.equal(evaluationCalls, 1);
  assert.equal(preview.eligible_for_monitoring, true);
  assert.equal(preview.due_in_normal_monitor, false);
  assert.equal(preview.persisted, false);
  assert.deepEqual(preview.detected_speakers, {
    Customer: 2,
    Bot: 2,
    Agent: 0
  });
  assert.deepEqual(preview.evaluation, evaluation);
});

test('inspect mode identifies speakers without calling the evaluator', async () => {
  const preview = await previewTicketMonitoring({
    ticketId: 5687,
    client: readOnlyTicketClient(),
    score: false,
    evaluate: () => {
      throw new Error('Evaluator must not run');
    }
  });

  assert.equal(preview.evaluation, null);
  assert.equal(preview.detected_speakers.Bot, 2);
});

test('preview rejects a non-numeric ticket ID before making any request', async () => {
  await assert.rejects(
    previewTicketMonitoring({
      ticketId: '5687/records',
      client: readOnlyTicketClient()
    }),
    /positive numeric ticket ID/
  );
});
