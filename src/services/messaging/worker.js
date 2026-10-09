import { randomUUID } from 'node:crypto';
import { claimNext, renewLease, finishJob } from '../../models/inbox/index.js';
import { processMessageEvent } from './index.js';
import { sendWelcomeMessage } from './messages.js';
import { logStage } from '../../common/utils/timingLogger.js';

const LEASE_RENEWAL_INTERVAL_MS = 30_000;

/**
 * Dispatch one claimed create or message event and preserve its queue-delay trace metadata.
 * @param {Object} job - Claimed create or customer-message job.
 * @returns {Promise<Object|void>} The delivered welcome response or completed customer-message processing result.
 */
async function processInboxJob(job) {
  const event = job.payload;
  const createdAt = job.created_at instanceof Date ? job.created_at.getTime() : Date.parse(job.created_at);
  const queueDelayMs = Number.isFinite(createdAt) ? Math.max(0, Date.now() - createdAt) : undefined;

  logStage('inbox.claimed', { queueDelayMs, attempt: job.attempts });

  if (job.event_type === 'conversation:create') {
    return sendWelcomeMessage(event);
  }

  if (job.event_type === 'conversation:message') {
    event._receivedAt = Date.now();
    event._queueDelayMs = queueDelayMs;

    return processMessageEvent(event);
  }
}

/**
 * Claim and renew a job lease, process it, and persist its in-memory completion or retry status.
 * @param {string} workerId - Worker owning the job lease.
 * @returns {Promise<boolean>} Whether a job was claimed and processed.
 */
export async function processOneInboxJob(workerId = randomUUID()) {
  const job = await claimNext(workerId);
  if (!job) {
    return false;
  }

  const leaseRenewalTimer = setInterval(() => {
    renewLease(job, workerId).catch(error => {
      console.error('Lease renewal failed', error.message);
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
    console.error('Inbox job failed', {
      sequenceId: job.sequence_id,
      status,
      attempts: job.attempts,
      message: processingError.message
    });
  }

  return true;
}
