import { bearerToken, secretsMatch } from '../../common/utils/index.js';

/**
 * Require the configured report bearer key using the existing constant-time comparison.
 * @param {Object} req - Express request.
 * @param {Object} res - Express response.
 * @param {Function} next - Express continuation callback.
 * @returns {void} Calls next for authorized callers or sends the existing access error.
 */
export function requireReportKey(req, res, next) {
  const configuredKey = process.env.REPORT_API_KEY;
  if (!configuredKey) {
    return res.status(503).json({ error: 'Report access is not configured' });
  }

  const authorizationHeader = req.get('authorization') || '';
  const receivedKey = bearerToken(authorizationHeader) || '';
  const keyMatches = secretsMatch(receivedKey, configuredKey);

  if (!keyMatches) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}
