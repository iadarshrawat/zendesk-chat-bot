import test from "node:test";
import assert from "node:assert/strict";
import {
  detectMonitoringSessions,
  isEscalatedMonitoringSession,
  normalizeConversationEvents,
} from "./monitoringSessionService.js";
import { buildMonitoringEvaluationInput, runReport } from "./monitoringJob.js";

const HOUR_MS = 60 * 60 * 1000;

function conversationEvent(id, at, type, speaker, text) {
  return {
    id,
    reference: id,
    type,
    created_at: new Date(at).toISOString(),
    author: { type: speaker },
    content: { text },
    metadata: { public: true },
  };
}

test("message timestamps split sessions after two hours without a customer message", () => {
  const start = Date.parse("2026-09-25T08:00:00Z");
  const messages = normalizeConversationEvents([
    conversationEvent("a", start, "Messaging::ConversationMessage", "end-user", "It failed"),
    conversationEvent("b", start + HOUR_MS, "Messaging::ConversationMessage", "bot", "Try again"),
    conversationEvent(
      "c",
      start + 2 * HOUR_MS,
      "Messaging::ConversationMessage",
      "end-user",
      "Still broken",
    ),
    conversationEvent("d", start + 2 * HOUR_MS + 60_000, "Comment", "agent", "I can help"),
    {
      ...conversationEvent("e", start + 3 * HOUR_MS, "Comment", "agent", "Internal note"),
      metadata: { public: false },
    },
  ], 123);

  assert.deepEqual(
    messages.map(message => message.speaker),
    ["Customer", "Bot", "Customer", "Agent"],
  );

  const sessions = detectMonitoringSessions(messages, 2 * HOUR_MS);

  assert.deepEqual(
    sessions.map(session => session.messages.map(message => message.id)),
    [["a", "b"], ["c", "d"]],
  );
  assert.equal(sessions[1].lastCustomerAt, start + 2 * HOUR_MS);
  assert.equal(isEscalatedMonitoringSession(sessions[0]), false);
  assert.equal(isEscalatedMonitoringSession(sessions[1]), true);
});

test("conversation API system messages are recognized as bot replies", () => {
  const createdAt = "2026-09-30T09:48:00.000Z";
  const messages = normalizeConversationEvents([
    {
      id: "bot-message-1",
      type: "Messaging::ConversationMessage",
      created_at: createdAt,
      author: { type: "system" },
      source: { type: "api:conversations" },
      content: { type: "text", text: "How can I help?" },
    },
  ], "requester-1");

  assert.deepEqual(messages, [{
    id: "bot-message-1",
    at: Date.parse(createdAt),
    speaker: "Bot",
    text: "How can I help?",
  }]);
});

test("LLM sees the full earlier conversation and only the target session's outcome", () => {
  const start = Date.parse("2026-09-25T08:00:00Z");
  const messages = normalizeConversationEvents([
    conversationEvent(
      "a",
      start,
      "Messaging::ConversationMessage",
      "end-user",
      "My heater will not start",
    ),
    conversationEvent(
      "b",
      start + 60_000,
      "Messaging::ConversationMessage",
      "bot",
      "Detailed advice: " + "x".repeat(45_000),
    ),
    conversationEvent(
      "c",
      start + 3 * HOUR_MS,
      "Messaging::ConversationMessage",
      "end-user",
      "That worked",
    ),
    conversationEvent(
      "d",
      start + 6 * HOUR_MS,
      "Messaging::ConversationMessage",
      "end-user",
      "Different issue",
    ),
  ], 123);

  const session = detectMonitoringSessions(messages, 2 * HOUR_MS)[1];
  const input = buildMonitoringEvaluationInput({
    ticket: { id: 123, subject: "Heater" },
    session,
    ticketMessages: messages,
  });

  assert.deepEqual(input.target_session.messages.map(message => message.id), ["c"]);
  assert.deepEqual(input.ticket_conversation.map(message => message.id), ["a", "b", "c"]);
  assert.ok(input.ticket_conversation[1].text.includes("x".repeat(45_000)));
});

test("the five-hour export resets each poll and the SQL Server ledger prevents repeat scoring", async () => {
  const start = Date.parse("2026-09-25T08:00:00Z");
  const currentTicket = {
    id: 123,
    support_type: "ai_agent",
    requester_id: 456,
    subject: "Help",
    created_at: new Date(start).toISOString(),
    updated_at: new Date(start + 7 * HOUR_MS).toISOString(),
    tags: [],
  };
  const staleTicket = {
    ...currentTicket,
    id: 999,
    updated_at: new Date(start + 2 * HOUR_MS).toISOString(),
  };
  const conversationEvents = [
    conversationEvent("a", start, "Messaging::ConversationMessage", "end-user", "Help me"),
    conversationEvent("b", start + 60_000, "Messaging::ConversationMessage", "bot", "Try this"),
    conversationEvent(
      "c",
      start + 3 * HOUR_MS,
      "Messaging::ConversationMessage",
      "end-user",
      "That worked",
    ),
    conversationEvent(
      "d",
      start + 3 * HOUR_MS + 60_000,
      "Messaging::ConversationMessage",
      "bot",
      "Great",
    ),
    conversationEvent(
      "e",
      start + 7 * HOUR_MS,
      "Messaging::ConversationMessage",
      "end-user",
      "New question",
    ),
  ];
  const storedRecords = new Map();
  const completionLedger = new Map();
  const requestedStartTimes = [];
  let conversationFetchCount = 0;
  let evaluationCount = 0;

  const zendeskClient = {
    async get(path, config = {}) {
      if (path === "/custom_objects/ticket_csat_scores") {
        return { data: {} };
      }

      if (path.endsWith("/fields")) {
        return { data: { custom_object_fields: [] } };
      }

      if (path === "/incremental/tickets/cursor") {
        if (config.params.cursor) {
          assert.equal(config.params.cursor, "next-page");
          return { data: { tickets: [], end_of_stream: true } };
        }

        requestedStartTimes.push(config.params.start_time);
        return {
          data: {
            tickets: [staleTicket, currentTicket],
            end_of_stream: false,
            after_cursor: "next-page",
          },
        };
      }

      if (path === "/tickets/999/conversation_log") {
        throw new Error("Stale ticket was fetched");
      }

      if (path === "/tickets/123/conversation_log") {
        conversationFetchCount++;
        return { data: { events: conversationEvents, meta: { has_more: false } } };
      }

      throw new Error(`Unexpected GET ${path}`);
    },
    async post(path, body) {
      if (path.endsWith("/fields")) {
        return { data: {} };
      }

      if (path.endsWith("/records/search")) {
        const requestedTicketId =
          body.filter["custom_object_fields.ticket_id"].$eq;
        const matchingRecords = [...storedRecords.values()].filter(
          record => record.custom_object_fields.ticket_id === requestedTicketId,
        );

        return {
          data: {
            custom_object_records: matchingRecords,
            meta: { has_more: false },
          },
        };
      }

      throw new Error(`Unexpected POST ${path}`);
    },
    async patch(path, body, config) {
      assert.equal(path, "/custom_objects/ticket_csat_scores/records");

      const externalId = config.params.external_id;
      const record = {
        external_id: externalId,
        custom_object_fields: body.custom_object_record.custom_object_fields,
      };
      storedRecords.set(externalId, record);

      return { data: { custom_object_record: record } };
    },
  };

  const database = {
    request() {
      const inputs = {};
      return {
        input(name, _type, value) {
          inputs[name] = value;
          return this;
        },
        async query(query) {
          if (query.startsWith("SELECT session_id")) {
            const matchingRows = [...completionLedger.values()].filter(
              row => row.ticket_id === inputs.ticketId,
            );
            return { recordset: matchingRows };
          }

          if (query.startsWith("INSERT INTO")) {
            if (!completionLedger.has(inputs.sessionId)) {
              completionLedger.set(inputs.sessionId, {
                session_id: inputs.sessionId,
                ticket_id: inputs.ticketId,
              });
            }
            return { rowsAffected: [1] };
          }

          throw new Error(`Unexpected SQL: ${query}`);
        },
      };
    },
  };

  const evaluateSession = async ({ session, ticketMessages }) => {
    evaluationCount++;
    assert.deepEqual(
      ticketMessages.map(message => message.id),
      ["a", "b", "c", "d", "e"],
    );

    return {
      customer_satisfaction: "neutral",
      human_required: false,
      follow_up_required: false,
      confidence: "medium",
      reason: `Session ${session.number} was answered.`,
      key_issue: null,
    };
  };

  const reportOptions = {
    client: zendeskClient,
    db: database,
    evaluate: evaluateSession,
  };

  const firstRun = await runReport({
    ...reportOptions,
    now: start + 8 * HOUR_MS,
  });
  assert.equal(firstRun.success, true);
  assert.equal(firstRun.results.length, 2);
  assert.deepEqual(firstRun.results.map(result => result.session_number), [1, 2]);
  assert.equal(Object.hasOwn(firstRun.summary, "resolution_breakdown"), false);
  assert.equal(completionLedger.size, 2);
  assert.equal(
    [...storedRecords.values()][0].custom_object_fields.session_message_count,
    "2",
  );
  assert.equal(
    Object.hasOwn([...storedRecords.values()][0].custom_object_fields, "resolution_status"),
    false,
  );
  assert.equal(
    Object.hasOwn([...storedRecords.values()][0].custom_object_fields, "returned_after_resolution"),
    false,
  );

  const secondRun = await runReport({
    ...reportOptions,
    now: start + 10 * HOUR_MS,
  });
  assert.equal(secondRun.success, true);
  assert.deepEqual(secondRun.results.map(result => result.session_number), [3]);

  const thirdRun = await runReport({
    ...reportOptions,
    now: start + 11 * HOUR_MS,
  });
  assert.equal(thirdRun.success, true);
  assert.equal(thirdRun.results.length, 0);

  const fourthRun = await runReport({
    ...reportOptions,
    now: start + 14 * HOUR_MS,
  });
  assert.equal(fourthRun.success, true);
  assert.equal(fourthRun.summary.total_tickets, 0);
  assert.equal(evaluationCount, 3);
  assert.equal(completionLedger.size, 3);
  assert.equal(storedRecords.size, 3);
  assert.equal(conversationFetchCount, 3);
  assert.deepEqual(
    requestedStartTimes,
    [8, 10, 11, 14].map(hours =>
      Math.floor((start + (hours - 5) * HOUR_MS) / 1000)),
  );
});

test("a saved custom-object result heals a failed SQL Server write without another LLM call", async () => {
  const start = Date.parse("2026-09-25T08:00:00Z");
  const now = start + 3 * HOUR_MS;
  const ticket = {
    id: 321,
    support_type: "ai_agent",
    requester_id: 88,
    updated_at: new Date(start + HOUR_MS).toISOString(),
    tags: [],
  };
  const conversationEvents = [
    conversationEvent(
      "customer",
      start,
      "Messaging::ConversationMessage",
      "end-user",
      "Question",
    ),
    conversationEvent(
      "bot",
      start + 60_000,
      "Messaging::ConversationMessage",
      "bot",
      "Answer",
    ),
  ];
  let storedRecord;
  let completed = false;
  let shouldFailLedgerWrite = true;
  let evaluationCount = 0;

  const zendeskClient = {
    async get(path) {
      if (path === "/custom_objects/ticket_csat_scores") {
        return { data: {} };
      }

      if (path.endsWith("/fields")) {
        return { data: { custom_object_fields: [] } };
      }

      if (path === "/incremental/tickets/cursor") {
        return { data: { tickets: [ticket], end_of_stream: true } };
      }

      if (path === "/tickets/321/conversation_log") {
        return {
          data: {
            events: conversationEvents,
            meta: { has_more: false },
          },
        };
      }

      throw new Error(`Unexpected GET ${path}`);
    },
    async post(path) {
      if (path.endsWith("/fields")) {
        return { data: {} };
      }

      if (path.endsWith("/records/search")) {
        return {
          data: {
            custom_object_records: storedRecord ? [storedRecord] : [],
            meta: { has_more: false },
          },
        };
      }

      throw new Error(`Unexpected POST ${path}`);
    },
    async patch(path, body, config) {
      storedRecord = {
        external_id: config.params.external_id,
        custom_object_fields: body.custom_object_record.custom_object_fields,
      };

      return { data: { custom_object_record: storedRecord } };
    },
  };

  const database = {
    request() {
      return {
        input() { return this; },
        async query(query) {
          if (query.startsWith("SELECT session_id")) {
            return { recordset: completed ? [{ session_id: storedRecord.external_id }] : [] };
          }

          if (query.startsWith("INSERT INTO")) {
            if (shouldFailLedgerWrite) {
              shouldFailLedgerWrite = false;
              throw new Error("Temporary SQL Server write failure");
            }

            completed = true;
            return { rowsAffected: [1] };
          }

          throw new Error(`Unexpected SQL: ${query}`);
        },
      };
    },
  };

  const evaluateSession = async () => {
    evaluationCount++;
    return {
      customer_satisfaction: "neutral",
      human_required: false,
      follow_up_required: false,
      confidence: "medium",
      reason: "Answer was provided.",
      key_issue: null,
    };
  };

  const reportOptions = {
    client: zendeskClient,
    db: database,
    evaluate: evaluateSession,
  };

  const firstRun = await runReport({ now, ...reportOptions });
  assert.equal(firstRun.success, false);
  assert.ok(storedRecord);

  const secondRun = await runReport({ now: now + 60_000, ...reportOptions });
  assert.equal(secondRun.success, true);
  assert.equal(secondRun.results.length, 0);
  assert.equal(evaluationCount, 1);
  assert.equal(completed, true);
});
