import { enqueueEvents, eligibleEvents, getInboxSnapshot } from '../../models/inbox/index.js';
import { notifyInbox } from '../../common/cron/index.js';

/**
 * Validate webhook events, enqueue the accepted batch, and wake the in-memory worker.
 * @param {Object} req - Express request.
 * @param {Object} res - Express response.
 * @returns {Promise<void>} Sends the existing acceptance, validation, or queue-unavailable response.
 */
export async function handleSunshineMessage(req, res) {
  try {
    const events = eligibleEvents(req.body?.events);
    await enqueueEvents(events, process.env.SUNSHINE_APP_ID);

    // 200 confirms acceptance into this process's memory only. A restart
    // before processing loses queued events.
    res.status(200).json({ received: true });
    if (events.length) {
      notifyInbox();
    }
  } catch (error) {
    if (error instanceof TypeError) {
      return res.status(400).json({ error: error.message });
    }

    console.error('Webhook queue failed', {
      code: error.code,
      message: error.message
    });
    res.status(503).json({ error: 'Webhook could not be queued' });
  }
}

/**
 * Return the process-local inbox counts for an authenticated report caller.
 * @param {Object} _req - Express request; authentication runs before this handler.
 * @param {Object} res - Express response.
 * @returns {Object} The JSON response containing counts without message payloads.
 */
export function getInboxDiagnostics(_req, res) {
  return res.json(getInboxSnapshot());
}
