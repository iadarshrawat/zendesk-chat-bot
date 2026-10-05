import { createHash } from "node:crypto";

const SUPPORTED_EVENT_TYPES = ["conversation:create", "conversation:message"];
const MAX_WEBHOOK_EVENTS = 100;
const MAX_JOB_ATTEMPTS = 5;
const LEASE_MS = 120_000;
const DEFAULT_MAX_ACTIVE_JOBS = 1_000;
const DEFAULT_MAX_RECENT_JOBS = 100;
const DEFAULT_MAX_RECENT_EVENT_IDS = 10_000;
const INBOX_STATUSES = ["pending", "processing", "done", "failed", "delivery_uncertain"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function eventKey(event, appId) {
  const conversationId = String(event.payload?.conversation?.id || "");
  const stableId = event.id || event.payload?.message?.id ||
    sha256(JSON.stringify(event));
  const eventIdentity = JSON.stringify([appId, conversationId, event.type, stableId]);

  return sha256(eventIdentity);
}

export function eligibleEvents(events) {
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_WEBHOOK_EVENTS) {
    throw new TypeError("Expected 1 to 100 webhook events");
  }

  return events.filter((event) => {
    if (!SUPPORTED_EVENT_TYPES.includes(event?.type)) {
      return false;
    }
    if (!event.payload?.conversation?.id) {
      throw new TypeError("Missing conversation id");
    }
    if (event.type === "conversation:message" && !event.payload?.message) {
      throw new TypeError("Missing message");
    }

    return true;
  });
}

/** Create a process-local inbox. Jobs and duplicate history disappear on restart. */
export function createInMemoryInbox({
  maxActiveJobs = DEFAULT_MAX_ACTIVE_JOBS,
  maxRecentJobs = DEFAULT_MAX_RECENT_JOBS,
  maxRecentEventIds = DEFAULT_MAX_RECENT_EVENT_IDS,
  now = Date.now,
} = {}) {
  const activeJobs = [];
  const activeByEventId = new Map();
  const recentJobs = [];
  const recentEventIds = new Set();
  let nextSequenceId = 1;

  function rememberCompletedJob(job) {
    recentJobs.push({ status: job.status });
    if (recentJobs.length > maxRecentJobs) {
      recentJobs.shift();
    }

    recentEventIds.add(job.event_id);
    if (recentEventIds.size > maxRecentEventIds) {
      recentEventIds.delete(recentEventIds.values().next().value);
    }
  }

  return {
    async enqueueEvents(events, appId) {
      const newEvents = [];
      const batchIds = new Set();
      const validEvents = eligibleEvents(events);

      for (const event of validEvents) {
        const id = eventKey(event, appId);
        if (activeByEventId.has(id) || recentEventIds.has(id) || batchIds.has(id)) {
          continue;
        }
        batchIds.add(id);
        newEvents.push({ event: structuredClone(event), id });
      }

      // Accept the entire webhook batch or reject it. The 503 lets Zendesk retry.
      if (activeJobs.length + newEvents.length > maxActiveJobs) {
        throw Object.assign(new Error("Inbox queue is full"), { code: "INBOX_FULL" });
      }

      const queuedAt = now();
      for (const { event, id } of newEvents) {
        const job = {
          sequence_id: nextSequenceId++,
          event_id: id,
          conversation_id: String(event.payload.conversation.id),
          event_type: event.type,
          payload: event,
          status: "pending",
          attempts: 0,
          available_at: queuedAt,
          lease_until: null,
          locked_by: null,
          last_error: null,
          created_at: new Date(queuedAt),
        };
        activeJobs.push(job);
        activeByEventId.set(id, job);
      }

      return { accepted: newEvents.length, duplicates: validEvents.length - newEvents.length };
    },

    async claimNext(workerId) {
      const currentTime = now();
      const blockedConversations = new Set();

      for (const job of activeJobs) {
        // An older job blocks later events in the same conversation, even
        // while it is processing or waiting for its retry time.
        if (blockedConversations.has(job.conversation_id)) {
          continue;
        }
        blockedConversations.add(job.conversation_id);

        const ready = job.status === "pending" && job.available_at <= currentTime;
        const expired = job.status === "processing" && job.lease_until < currentTime;
        if (!ready && !expired) {
          continue;
        }

        job.status = "processing";
        job.attempts += 1;
        job.locked_by = workerId;
        job.lease_until = currentTime + LEASE_MS;
        return { ...job, payload: structuredClone(job.payload) };
      }

      return null;
    },

    async renewLease(job, workerId) {
      const storedJob = activeByEventId.get(job.event_id);
      if (
        storedJob?.sequence_id !== job.sequence_id ||
        storedJob.status !== "processing" ||
        storedJob.locked_by !== workerId
      ) {
        return false;
      }

      storedJob.lease_until = now() + LEASE_MS;
      return true;
    },

    async finishJob(job, workerId, error) {
      const storedJob = activeByEventId.get(job.event_id);
      if (
        storedJob?.sequence_id !== job.sequence_id ||
        storedJob.status !== "processing" ||
        storedJob.locked_by !== workerId
      ) {
        throw new Error("Job lease was lost before completion");
      }

      const deliveryIsUncertain = error?.deliveryUncertain === true;
      const attemptsAreExhausted = Boolean(error) && job.attempts >= MAX_JOB_ATTEMPTS;
      let status = "done";
      if (deliveryIsUncertain) {
        status = "delivery_uncertain";
      } else if (attemptsAreExhausted) {
        status = "failed";
      } else if (error) {
        status = "pending";
      }

      const backoffSeconds = Math.min(300, 2 ** job.attempts * 5);
      storedJob.status = status;
      storedJob.locked_by = null;
      storedJob.lease_until = null;
      storedJob.available_at = now() + backoffSeconds * 1_000;
      storedJob.last_error = error ? String(error.message || error).slice(0, 500) : null;

      if (status !== "pending") {
        activeJobs.splice(activeJobs.indexOf(storedJob), 1);
        activeByEventId.delete(storedJob.event_id);
        rememberCompletedJob(storedJob);
      }

      return status;
    },

    // Terminal counts cover only the most recently retained job outcomes.
    snapshot() {
      const counts = Object.fromEntries(INBOX_STATUSES.map(status => [status, 0]));
      for (const job of activeJobs) counts[job.status] += 1;
      for (const job of recentJobs) counts[job.status] += 1;

      return {
        counts,
        active: activeJobs.length,
        capacity: maxActiveJobs,
        recent: recentJobs.length,
      };
    },
  };
}

const inbox = createInMemoryInbox();

export const enqueueEvents = (...args) => inbox.enqueueEvents(...args);
export const claimNext = (...args) => inbox.claimNext(...args);
export const renewLease = (...args) => inbox.renewLease(...args);
export const finishJob = (...args) => inbox.finishJob(...args);
export const getInboxSnapshot = () => inbox.snapshot();
