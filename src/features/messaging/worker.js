import { randomUUID } from "node:crypto";
import { claimNext, renewLease, finishJob } from "./inboxRepository.js";
import { processMessageEvent } from "./processMessageEvent.js";
import { sendWelcomeMessage } from "./messageGateway.js";
import { logStage } from "../../shared/timingLogger.js";

const LEASE_RENEWAL_INTERVAL_MS = 30_000;

export async function processInboxJob(job) {
  const event = job.payload;
  const createdAt = job.created_at instanceof Date
    ? job.created_at.getTime()
    : Date.parse(job.created_at);
  const queueDelayMs = Number.isFinite(createdAt) ? Math.max(0, Date.now() - createdAt) : undefined;

  logStage("inbox.claimed", { queueDelayMs, attempt: job.attempts });

  if (job.event_type === "conversation:create") {
    return sendWelcomeMessage(event);
  }

  if (job.event_type === "conversation:message") {
    event._receivedAt = Date.now();
    event._queueDelayMs = queueDelayMs;
    return processMessageEvent(event);
  }
}

export async function processOneInboxJob(workerId = randomUUID()) {
  const job = await claimNext(workerId);
  if (!job) {
    return false;
  }

  const leaseRenewalTimer = setInterval(() => {
    renewLease(job, workerId).catch((error) => {
      console.error("Lease renewal failed", error.message);
    });
  }, LEASE_RENEWAL_INTERVAL_MS);
  leaseRenewalTimer.unref();

  let processingError;
  try {
    await processInboxJob(job);
  } catch (error) {
    processingError = error;
  } finally {
    clearInterval(leaseRenewalTimer);
  }

  const status = await finishJob(job, workerId, processingError);
  if (processingError) {
    console.error("Inbox job failed", {
      sequenceId: job.sequence_id,
      status,
      attempts: job.attempts,
      message: processingError.message,
    });
  }

  return true;
}
