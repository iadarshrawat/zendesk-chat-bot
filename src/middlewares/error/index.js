/**
 * Log an unhandled request failure and preserve existing parser-error responses.
 * @param {Error} error - Original Express request error.
 * @param {Object} _req - Express request.
 * @param {Object} res - Express response.
 * @param {Function} _next - Express error-middleware signature.
 * @returns {void} Sends the existing generic error unless headers were already sent.
 */
export function handleRequestError(error, _req, res, _next) {
  console.error('HTTP request failed', { message: error.message });
  if (res.headersSent) {
    return;
  }

  let status = 500;
  if (error.type === 'entity.too.large') {
    status = 413;
  } else if (error instanceof SyntaxError && 'body' in error) {
    status = 400;
  }

  res.status(status).json({ error: 'Request failed' });
}
