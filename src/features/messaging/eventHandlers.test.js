import test from "node:test";
import assert from "node:assert/strict";
import { createCustomerMessageProcessor } from "./eventHandlers.js";
import { normalizeConversationState } from "./conversationContext.js";
import { createResponseBudget, runWithDeadline } from "../../shared/responseBudget.js";

const event = {
  payload: {
    message: { id: "test-message", author: { userId: "customer" }, content: { text: "Show fans" } },
    conversation: { brandId: "brand" },
  },
};
const answer = {
  status: "answered",
  reply: "Here are supported options.",
  plan: { filters: {}, caseFacts: [] },
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function services(overrides = {}) {
  return {
    resolveBrand: () => "Example",
    readHistory: async () => "",
    loadState: async () => normalizeConversationState(),
    generateReply: async () => answer,
    sendReply: async () => {},
    sendTyping: async () => {},
    saveState: async () => {},
    ...overrides,
  };
}

test("a pending typing-start does not block generation or delivery; cleanup follows delivery", async () => {
  const calls = [];
  const sent = deferred();
  const saved = deferred();
  const stopped = deferred();
  const budget = createResponseBudget({ timeoutMs: 5_000, reserveMs: 1_000 });
  const processMessage = createCustomerMessageProcessor(services({
    sendTyping: async (_id, state, _user, options) => {
      calls.push(`typing_${state}`);
      if (state === "start") {
        await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
        calls.push("start_settled");
      } else {
        return stopped.promise;
      }
    },
    generateReply: async () => { calls.push("generate"); return answer; },
    sendReply: async () => { calls.push("send"); sent.resolve(); },
    saveState: async (_id, state, options) => {
      assert.equal(state.activeRequest, "Show fans");
      assert.ok(options.timeoutMs > 500);
      calls.push("save");
      return saved.promise;
    },
  }));
  const processing = processMessage(event, "conversation", null, null, { responseBudget: budget });

  try {
    await runWithDeadline(() => sent.promise, { timeoutMs: 1_000 });
    // Allow both cleanup tasks to start without resolving either task.
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(calls.indexOf("generate") < calls.indexOf("start_settled"));
    assert.ok(calls.indexOf("send") < calls.indexOf("typing_stop"));
    assert.ok(calls.indexOf("start_settled") < calls.indexOf("typing_stop"));
    assert.ok(calls.includes("save"));
    assert.ok(calls.includes("typing_stop"));
  } finally {
    budget.cancel();
    saved.resolve();
    stopped.resolve();
    await processing;
  }
});

test("an uncertain delivery is not retried and typing is stopped even if cleanup fails", async () => {
  const calls = [];
  const failure = Object.assign(new Error("delivery timed out"), { deliveryUncertain: true });
  const processMessage = createCustomerMessageProcessor(services({
    sendReply: async () => { calls.push("send"); throw failure; },
    sendTyping: async (_id, state) => {
      calls.push(`typing_${state}`);
      if (state === "stop") throw new Error("typing timed out");
    },
    saveState: async () => calls.push("save"),
  }));

  await assert.rejects(processMessage(event, "conversation", null, null), error => error === failure);
  assert.deepEqual(calls, ["typing_start", "send", "typing_stop"]);
});

test("a failed state save cannot turn a delivered answer into a retry", async () => {
  let sends = 0;
  let stops = 0;
  const processMessage = createCustomerMessageProcessor(services({
    sendReply: async () => { sends += 1; },
    sendTyping: async (_id, state) => { if (state === "stop") stops += 1; },
    saveState: async () => { throw Object.assign(new Error("SQL timed out"), { code: "ETIMEOUT" }); },
  }));

  await processMessage(event, "conversation", null, null);
  assert.equal(sends, 1);
  assert.equal(stops, 1);
});
