import { secretsMatch } from '../../common/utils/index.js';

/**
 * Verify the configured webhook key and require the expected Sunshine app ID.
 * @param {Object} req - Express request.
 * @param {Object} res - Express response.
 * @param {Function} next - Express continuation callback.
 * @returns {void} Calls next for a trusted webhook or sends the existing rejection response.
 */
export function verifySunshineWebhook(req, res, next) {
  const expectedApiKey = process.env.SUNSHINE_WEBHOOK_SECRET;
  const providedApiKey = req.get('x-api-key');

  if (!expectedApiKey) {
    return res.status(503).json({ error: 'Webhook is not configured' });
  }

  if (!secretsMatch(providedApiKey, expectedApiKey)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.body?.app?.id !== process.env.SUNSHINE_APP_ID) {
    return res.status(400).json({ error: 'Unexpected app' });
  }

  next();
}
