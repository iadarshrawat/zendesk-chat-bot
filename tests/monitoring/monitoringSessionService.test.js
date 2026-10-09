import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectMonitoringSessions,
  isEscalatedMonitoringSession,
  normalizeConversationEvents
} from '../../src/services/monitoring/sessions.js';
import { runReport } from '../../src/services/monitoring/index.js';
import { buildMonitoringEvaluationInput, parseMonitoringEvaluation } from '../../src/services/monitoring/evaluation.js';
import { monitoringIssueType } from '../../src/common/monitoring/index.js';

const HOUR_MS = 60 * 60 * 1000;

function conversationEvent(id, at, type, speaker, text) {
  return {
    id,
    reference: id,
    type,
    created_at: new Date(at).toISOString(),
    author: { type: speaker },
    content: { text },
    metadata: { public: true }
  };
}

test('message timestamps split sessions after two hours without a customer message', () => {
  const start = Date.parse('2026-09-25T08:00:00Z');
  const messages = normalizeConversationEvents(
    [
      conversationEvent('a', start, 'Messaging::ConversationMessage', 'end-user', 'It failed'),
      conversationEvent('b', start + HOUR_MS, 'Messaging::ConversationMessage', 'bot', 'Try again'),
      conversationEvent('c', start + 2 * HOUR_MS, 'Messaging::ConversationMessage', 'end-user', 'Still broken'),
      conversationEvent('d', start + 2 * HOUR_MS + 60_000, 'Comment', 'agent', 'I can help'),
      {
        ...conversationEvent('e', start + 3 * HOUR_MS, 'Comment', 'agent', 'Internal note'),
        metadata: { public: false }
      }
    ],
    123
  );

  assert.deepEqual(
    messages.map(message => message.speaker),
    ['Customer', 'Bot', 'Customer', 'Agent']
  );

  const sessions = detectMonitoringSessions(messages, 2 * HOUR_MS);

  assert.deepEqual(
    sessions.map(session => session.messages.map(message => message.id)),
    [
      ['a', 'b'],
      ['c', 'd']
    ]
  );
  assert.equal(sessions[1].lastCustomerAt, start + 2 * HOUR_MS);
  assert.equal(isEscalatedMonitoringSession(sessions[0]), false);
  assert.equal(isEscalatedMonitoringSession(sessions[1]), true);
});

test('conversation API system messages are recognized as bot replies', () => {
  const createdAt = '2026-09-30T09:48:00.000Z';
  const messages = normalizeConversationEvents(
    [
      {
        id: 'bot-message-1',
        type: 'Messaging::ConversationMessage',
        created_at: createdAt,
        author: { type: 'system' },
        source: { type: 'api:conversations' },
        content: { type: 'text', text: 'How can I help?' }
      }
    ],
    'requester-1'
  );

  assert.deepEqual(messages, [
    {
      id: 'bot-message-1',
      at: Date.parse(createdAt),
      speaker: 'Bot',
      text: 'How can I help?'
    }
  ]);
});

test("LLM sees the full earlier conversation and only the target session's outcome", () => {
  const start = Date.parse('2026-09-25T08:00:00Z');
  const messages = normalizeConversationEvents(
    [
      conversationEvent('a', start, 'Messaging::ConversationMessage', 'end-user', 'My heater will not start'),
      conversationEvent('b', start + 60_000, 'Messaging::ConversationMessage', 'bot', 'Detailed advice: ' + 'x'.repeat(45_000)),
      conversationEvent('c', start + 3 * HOUR_MS, 'Messaging::ConversationMessage', 'end-user', 'That worked'),
      conversationEvent('d', start + 6 * HOUR_MS, 'Messaging::ConversationMessage', 'end-user', 'Different issue')
    ],
    123
  );

  const session = detectMonitoringSessions(messages, 2 * HOUR_MS)[1];
  const input = buildMonitoringEvaluationInput({
    ticket: { id: 123, subject: 'Heater' },
    session,
    ticketMessages: messages
  });

  assert.deepEqual(
    input.target_session.messages.map(message => message.id),
    ['c']
  );
  assert.deepEqual(
    input.ticket_conversation.map(message => message.id),
    ['a', 'b', 'c']
  );
  assert.ok(input.ticket_conversation[1].text.includes('x'.repeat(45_000)));
});

function sqlStore({ failFirstWrite = false } = {}) {
  const completed = new Map();
  const evaluations = new Map();

  return {
    completed,
    evaluations,
    request() {
      const values = {};

      return {
        input(name, _type, value) {
          values[name] = value;

          return this;
        },
        cancel() {},
        async query(query) {
          if (query.startsWith('SELECT session_id')) {
            return {
              recordset: [...completed.values()].filter(row => row.ticket_id === values.ticketId)
            };
          }
          assert.match(query, /BEGIN TRANSACTION/);
          assert.match(query, /ROLLBACK TRANSACTION/);
          assert.match(query, /INSERT INTO .*bot_monitor_evaluations/);
          if (failFirstWrite) {
            failFirstWrite = false;
            throw new Error('Temporary SQL write failure');
          }
          if (evaluations.has(values.session_id)) {
            return { recordset: [{ written: false }] };
          }
          completed.set(values.session_id, {
            session_id: values.session_id,
            ticket_id: values.ticket_id
          });
          evaluations.set(values.session_id, { ...values });

          return { recordset: [{ written: true }] };
        }
      };
    }
  };
}

function ticketClient(ticket, events, startTimes = []) {
  return {
    async get(path, { params }) {
      if (path === '/incremental/tickets/cursor') {
        startTimes.push(params.start_time);

        return { data: { tickets: [ticket], end_of_stream: true } };
      }
      if (path === `/tickets/${ticket.id}/conversation_log`) {
        return { data: { events, meta: { has_more: false } } };
      }
      throw new Error(`Unexpected Zendesk request ${path}`);
    },
    async post() {
      throw new Error('Monitoring must not write custom objects');
    },
    async patch() {
      throw new Error('Monitoring must not write custom objects');
    }
  };
}

const evaluation = {
  customer_satisfaction: 'neutral',
  human_required: false,
  follow_up_required: false,
  confidence: 'medium',
  reason: 'Answer was provided.',
  key_issue: null,
  issue_type: 'product_information'
};

test('SQL stores complete evaluations and repeated polls never score a completed session again', async () => {
  const start = Date.parse('2026-09-25T08:00:00Z');
  const ticket = {
    id: 123,
    support_type: 'ai_agent',
    requester_id: 456,
    subject: 'Help',
    created_at: new Date(start).toISOString(),
    updated_at: new Date(start + 7 * HOUR_MS).toISOString(),
    tags: []
  };
  const events = [
    conversationEvent('a', start, 'Messaging::ConversationMessage', 'end-user', 'Help'),
    conversationEvent('b', start + 60_000, 'Messaging::ConversationMessage', 'bot', 'Try this'),
    conversationEvent('c', start + 3 * HOUR_MS, 'Messaging::ConversationMessage', 'end-user', 'It worked'),
    conversationEvent('d', start + 3 * HOUR_MS + 60_000, 'Messaging::ConversationMessage', 'bot', 'Great'),
    conversationEvent('e', start + 7 * HOUR_MS, 'Messaging::ConversationMessage', 'end-user', 'Another question')
  ];
  const db = sqlStore();
  const startTimes = [];
  let calls = 0;
  const options = {
    db,
    client: ticketClient(ticket, events, startTimes),
    evaluate: async () => {
      calls++;

      return evaluation;
    }
  };
  const first = await runReport({ ...options, now: start + 8 * HOUR_MS });
  assert.equal(first.success, true);
  assert.deepEqual(
    first.results.map(row => row.session_number),
    [1, 2]
  );
  const stored = [...db.evaluations.values()][0];
  assert.equal(stored.reason, evaluation.reason);
  assert.equal(stored.issue_type, 'product_information');
  assert.equal(stored.message_count, 2);
  assert.equal(stored.human_required, false);
  assert.equal(stored.csat_score, 'neutral');
  assert.equal(stored.report_date.toISOString().slice(0, 10), '2026-09-25');
  assert.equal(Object.hasOwn(stored, 'resolution_status'), false);
  const second = await runReport({ ...options, now: start + 10 * HOUR_MS });
  assert.deepEqual(
    second.results.map(row => row.session_number),
    [3]
  );
  const third = await runReport({ ...options, now: start + 11 * HOUR_MS });
  assert.equal(third.results.length, 0);
  const fourth = await runReport({ ...options, now: start + 14 * HOUR_MS });
  assert.equal(fourth.summary.total_tickets, 0);
  assert.equal(calls, 3);
  assert.equal(db.completed.size, 3);
  assert.equal(db.evaluations.size, 3);
  assert.deepEqual(
    startTimes,
    [8, 10, 11, 14].map(hours => Math.floor((start + (hours - 5) * HOUR_MS) / 1000))
  );
});

test('the evaluator must return a supported issue category independently of the satisfaction reason', () => {
  const value = parseMonitoringEvaluation(JSON.stringify(evaluation));
  assert.equal(value.issue_type, 'product_information');
  assert.equal(value.reason, evaluation.reason);
  for (const invalid of [undefined, null, 'Product information', 'refund', {}, 'satisfied']) {
    assert.throws(() => parseMonitoringEvaluation(JSON.stringify({ ...evaluation, issue_type: invalid })), /invalid monitoring fields/);
  }
  assert.throws(() => parseMonitoringEvaluation('null'), /invalid monitoring fields/);
  assert.throws(() => parseMonitoringEvaluation('not JSON'), /invalid monitoring JSON/);
  assert.equal(monitoringIssueType(null), 'unknown');
  assert.equal(monitoringIssueType(undefined), 'unknown');
  assert.throws(() => monitoringIssueType('unsupported'), /Invalid monitoring issue type/);
});

test('failed SQL persistence does not mark completion; a later poll can commit the result', async () => {
  const start = Date.parse('2026-09-25T08:00:00Z');
  const ticket = {
    id: 321,
    requester_id: 88,
    support_type: 'ai_agent',
    updated_at: new Date(start + HOUR_MS).toISOString()
  };
  const events = [
    conversationEvent('a', start, 'Messaging::ConversationMessage', 'end-user', 'Help'),
    conversationEvent('b', start + 60_000, 'Messaging::ConversationMessage', 'bot', 'Advice')
  ];
  const db = sqlStore({ failFirstWrite: true });
  let calls = 0;
  const options = {
    db,
    client: ticketClient(ticket, events),
    evaluate: async () => {
      calls++;

      return evaluation;
    }
  };
  assert.equal((await runReport({ ...options, now: start + 3 * HOUR_MS })).success, false);
  assert.equal(db.completed.size, 0);
  assert.equal(db.evaluations.size, 0);
  assert.equal((await runReport({ ...options, now: start + 3 * HOUR_MS + 60_000 })).success, true);
  assert.equal(db.completed.size, 1);
  assert.equal((await runReport({ ...options, now: start + 3 * HOUR_MS + 120_000 })).results.length, 0);
  assert.equal(calls, 2);
});
