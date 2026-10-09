import { createHash } from 'node:crypto';

const SUPPORTED_EVENT_TYPES = ['conversation:create', 'conversation:message'];
const MAX_WEBHOOK_EVENTS = 100;
const MAX_JOB_ATTEMPTS = 5;
const LEASE_MS = 120_000;
const DEFAULT_MAX_ACTIVE_JOBS = 1_000;
const DEFAULT_MAX_RECENT_JOBS = 100;
const DEFAULT_MAX_RECENT_EVENT_IDS = 10_000;
const INBOX_STATUSES = ['pending', 'processing', 'done', 'failed', 'delivery_uncertain'];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Build a stable webhook identity from the app, conversation, event type, and event ID.
 * @param {Object} event - Sunshine webhook event.
 * @param {string} appId - Configured Sunshine app ID.
 * @returns {string} The SHA-256 event key used for deduplication.
 */
export function eventKey(event, appId) {
  const conversationId = String(event.payload?.conversation?.id || '');
  const stableId = event.id || event.payload?.message?.id || sha256(JSON.stringify(event));
  const eventIdentity = JSON.stringify([appId, conversationId, event.type, stableId]);

  return sha256(eventIdentity);
}

/**
 * Validate webhook batch bounds and retain only supported conversation events.
 * @param {Array<Object>} events - Conversation or webhook events.
 * @returns {Array<Object>} Eligible events; throws for malformed supported events.
 */
export function eligibleEvents(events) {
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_WEBHOOK_EVENTS) {
    throw new TypeError('Expected 1 to 100 webhook events');
  }

  return events.filter(event => {
    if (!SUPPORTED_EVENT_TYPES.includes(event?.type)) {
      return false;
    }
    if (!event.payload?.conversation?.id) {
      throw new TypeError('Missing conversation id');
    }
    if (event.type === 'conversation:message' && !event.payload?.message) {
      throw new TypeError('Missing message');
    }

    return true;
  });
}

/**
 * Create the bounded process-local event queue with deduplication and per-conversation ordering.
 * @param {Object} options - Options: maxActiveJobs, maxRecentJobs, maxRecentEventIds, now.
 * @returns {Object} Queue, lease, completion, and snapshot operations; contents disappear on restart.
 */
export function createInMemoryInbox({
  maxActiveJobs = DEFAULT_MAX_ACTIVE_JOBS,
  maxRecentJobs = DEFAULT_MAX_RECENT_JOBS,
  maxRecentEventIds = DEFAULT_MAX_RECENT_EVENT_IDS,
  now = Date.now
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
    /**
     * Validate and atomically accept a webhook batch, ignoring known duplicate events.
     * @param {Array<Object>} events - Conversation or webhook events.
     * @param {string} appId - Configured Sunshine app ID.
     * @returns {Promise<Object>} Accepted and duplicate counts; rejects if the queue would exceed capacity.
     */
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
        throw Object.assign(new Error('Inbox queue is full'), {
          code: 'INBOX_FULL'
        });
      }

      const queuedAt = now();
      for (const { event, id } of newEvents) {
        const job = {
          sequence_id: nextSequenceId++,
          event_id: id,
          conversation_id: String(event.payload.conversation.id),
          event_type: event.type,
          payload: event,
          status: 'pending',
          attempts: 0,
          available_at: queuedAt,
          lease_until: null,
          locked_by: null,
          last_error: null,
          created_at: new Date(queuedAt)
        };
        activeJobs.push(job);
        activeByEventId.set(id, job);
      }

      return {
        accepted: newEvents.length,
        duplicates: validEvents.length - newEvents.length
      };
    },

    /**
     * Lease the next ready event while preserving event order within each conversation.
     * @param {string} workerId - Worker owning the job lease.
     * @returns {Promise<Object|null>} A copy of the claimed job, or null when no job is ready.
     */
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

        const ready = job.status === 'pending' && job.available_at <= currentTime;
        const expired = job.status === 'processing' && job.lease_until < currentTime;
        if (!ready && !expired) {
          continue;
        }

        job.status = 'processing';
        job.attempts += 1;
        job.locked_by = workerId;
        job.lease_until = currentTime + LEASE_MS;

        return { ...job, payload: structuredClone(job.payload) };
      }

      return null;
    },

    /**
     * Extend the lease only when the caller still owns the processing job.
     * @param {Object} job - Claimed inbox job.
     * @param {string} workerId - Worker owning the job lease.
     * @returns {Promise<boolean>} Whether the existing worker lease was renewed.
     */
    async renewLease(job, workerId) {
      const storedJob = activeByEventId.get(job.event_id);
      if (storedJob?.sequence_id !== job.sequence_id || storedJob.status !== 'processing' || storedJob.locked_by !== workerId) {
        return false;
      }

      storedJob.lease_until = now() + LEASE_MS;

      return true;
    },

    /**
     * Complete, retry, or quarantine a leased job using the existing delivery and attempt rules.
     * @param {Object} job - Claimed inbox job.
     * @param {string} workerId - Worker owning the job lease.
     * @param {Error} error - Original failure to inspect or handle.
     * @returns {Promise<string>} The resulting inbox status; rejects if ownership was lost.
     */
    async finishJob(job, workerId, error) {
      const storedJob = activeByEventId.get(job.event_id);
      if (storedJob?.sequence_id !== job.sequence_id || storedJob.status !== 'processing' || storedJob.locked_by !== workerId) {
        throw new Error('Job lease was lost before completion');
      }

      const deliveryIsUncertain = error?.deliveryUncertain === true;
      const attemptsAreExhausted = Boolean(error) && job.attempts >= MAX_JOB_ATTEMPTS;
      let status = 'done';
      if (deliveryIsUncertain) {
        status = 'delivery_uncertain';
      } else if (attemptsAreExhausted) {
        status = 'failed';
      } else if (error) {
        status = 'pending';
      }

      const backoffSeconds = Math.min(300, 2 ** job.attempts * 5);
      storedJob.status = status;
      storedJob.locked_by = null;
      storedJob.lease_until = null;
      storedJob.available_at = now() + backoffSeconds * 1_000;
      storedJob.last_error = error ? String(error.message || error).slice(0, 500) : null;

      if (status !== 'pending') {
        activeJobs.splice(activeJobs.indexOf(storedJob), 1);
        activeByEventId.delete(storedJob.event_id);
        rememberCompletedJob(storedJob);
      }

      return status;
    },

    // Terminal counts cover only the most recently retained job outcomes.
    /**
     * Summarize active jobs and retained terminal outcomes without exposing event payloads.
     * @returns {Object} Inbox status counts and capacity information.
     */
    snapshot() {
      const counts = Object.fromEntries(INBOX_STATUSES.map(status => [status, 0]));
      for (const job of activeJobs) {
        counts[job.status] += 1;
      }
      for (const job of recentJobs) {
        counts[job.status] += 1;
      }

      return {
        counts,
        active: activeJobs.length,
        capacity: maxActiveJobs,
        recent: recentJobs.length
      };
    }
  };
}

const inbox = createInMemoryInbox();

export const enqueueEvents = (...args) => inbox.enqueueEvents(...args);
export const claimNext = (...args) => inbox.claimNext(...args);
export const renewLease = (...args) => inbox.renewLease(...args);
export const finishJob = (...args) => inbox.finishJob(...args);
export const getInboxSnapshot = () => inbox.snapshot();
