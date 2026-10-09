import { checkDatabaseConnection } from '../../loaders/database/sql.js';

export function livenessCheck(_req, res) {
  return res.json({ status: 'ok' });
}

/**
 * Report readiness using the existing SQL connectivity check.
 * @param {Object} _req - Express request.
 * @param {Object} res - Express response.
 * @returns {Promise<void>} Sends ready or the existing 503 unavailable response.
 */
export async function readinessCheck(_req, res) {
  try {
    await checkDatabaseConnection();
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
}
