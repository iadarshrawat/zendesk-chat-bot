import cors from 'cors';

function getAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

function createOriginGuard(allowedOrigins) {
  return function requireAllowedOrigin(req, res, next) {
    const origin = req.get('origin');
    if (origin && !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }

    next();
  };
}

/**
 * Build the existing widget origin guard and CORS middleware from ALLOWED_ORIGINS.
 * @returns {Object} requireAllowedOrigin and widgetCors for the authentication routes.
 */
export function createWidgetAccess() {
  const allowedOrigins = getAllowedOrigins();
  const requireAllowedOrigin = createOriginGuard(allowedOrigins);
  const widgetCors = cors({
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.includes(origin));
    }
  });

  return { requireAllowedOrigin, widgetCors };
}
