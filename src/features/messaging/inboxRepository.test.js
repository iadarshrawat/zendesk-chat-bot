import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryInbox, eligibleEvents, eventKey } from "./inboxRepository.js";

function messageEvent(id, conversationId = "conversation-1") {
  return {
    type: "conversation:message",
    payload: { conversation: { id: conversationId }, message: { id } },
  };
}

test("webhook events keep stable keys and reject malformed messages", () => {
  const event = messageEvent("message-1");

  assert.equal(eventKey(event, "app-1"), eventKey(structuredClone(event), "app-1"));
  assert.notEqual(eventKey(event, "app-1"), eventKey(event, "app-2"));
  assert.equal(eligibleEvents([event]).length, 1);
  assert.throws(() => eligibleEvents([{ type: "conversation:message", payload: {} }]));
});

test("queue accepts a whole batch or rejects it when full, and deduplicates events", async () => {
  const inbox = createInMemoryInbox({ maxActiveJobs: 2 });
  const first = messageEvent("message-1");
  const second = messageEvent("message-2");
  const third = messageEvent("message-3");

  assert.deepEqual(await inbox.enqueueEvents([first, first], "app-1"), {
    accepted: 1,
    duplicates: 1,
  });
  assert.deepEqual(await inbox.enqueueEvents([first], "app-1"), {
    accepted: 0,
    duplicates: 1,
  });
  await assert.rejects(
    inbox.enqueueEvents([second, third], "app-1"),
    error => error.code === "INBOX_FULL",
  );
  assert.equal(inbox.snapshot().active, 1);

  const job = await inbox.claimNext("worker-1");
  assert.equal(await inbox.finishJob(job, "worker-1"), "done");
  assert.deepEqual(await inbox.enqueueEvents([first], "app-1"), {
    accepted: 0,
    duplicates: 1,
  });
  assert.deepEqual(await inbox.enqueueEvents([second, third], "app-1"), {
    accepted: 2,
    duplicates: 0,
  });
});

test("an older conversation job blocks later messages through processing and retry", async () => {
  let currentTime = 0;
  const inbox = createInMemoryInbox({ now: () => currentTime });
  await inbox.enqueueEvents([
    messageEvent("first", "conversation-a"),
    messageEvent("second", "conversation-a"),
    messageEvent("other", "conversation-b"),
  ], "app-1");

  const first = await inbox.claimNext("worker-1");
  assert.equal(first.payload.payload.message.id, "first");
  const other = await inbox.claimNext("worker-2");
  assert.equal(other.payload.payload.message.id, "other");
  assert.equal(await inbox.claimNext("worker-3"), null);

  assert.equal(await inbox.finishJob(first, "worker-1", new Error("Temporary failure")), "pending");
  assert.equal(await inbox.claimNext("worker-3"), null);
  currentTime = 10_000;
  const retry = await inbox.claimNext("worker-3");
  assert.equal(retry.payload.payload.message.id, "first");
  assert.equal(retry.attempts, 2);
  assert.equal(await inbox.finishJob(retry, "worker-3"), "done");

  const second = await inbox.claimNext("worker-3");
  assert.equal(second.payload.payload.message.id, "second");
});

test("uncertain delivery is quarantined without an automatic retry", async () => {
  const inbox = createInMemoryInbox();
  const event = messageEvent("uncertain");
  await inbox.enqueueEvents([event], "app-1");
  const job = await inbox.claimNext("worker-1");
  const error = Object.assign(new Error("Post may have succeeded"), {
    deliveryUncertain: true,
  });

  assert.equal(await inbox.finishJob(job, "worker-1", error), "delivery_uncertain");
  assert.equal(await inbox.claimNext("worker-1"), null);
  assert.equal(inbox.snapshot().counts.delivery_uncertain, 1);
  assert.equal((await inbox.enqueueEvents([event], "app-1")).duplicates, 1);
});

test("repeated failures stop after five attempts", async () => {
  let currentTime = 0;
  const inbox = createInMemoryInbox({ now: () => currentTime });
  await inbox.enqueueEvents([messageEvent("retry")], "app-1");

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const job = await inbox.claimNext("worker-1");
    assert.equal(job.attempts, attempt);
    const status = await inbox.finishJob(job, "worker-1", new Error("Temporary failure"));
    assert.equal(status, attempt === 5 ? "failed" : "pending");
    currentTime += Math.min(300, 2 ** attempt * 5) * 1_000;
  }

  assert.equal(await inbox.claimNext("worker-1"), null);
  assert.equal(inbox.snapshot().counts.failed, 1);
});

test("a renewed lease prevents another worker from claiming the job", async () => {
  let currentTime = 0;
  const inbox = createInMemoryInbox({ now: () => currentTime });
  await inbox.enqueueEvents([messageEvent("lease")], "app-1");

  const job = await inbox.claimNext("worker-1");
  currentTime = 119_000;
  assert.equal(await inbox.renewLease(job, "worker-1"), true);
  currentTime = 121_000;
  assert.equal(await inbox.claimNext("worker-2"), null);
  assert.equal(await inbox.finishJob(job, "worker-1"), "done");
});
