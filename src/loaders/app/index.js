import express from 'express';
import { createRoutes } from '../../routers/index.js';
import { handleRequestError } from '../../middlewares/index.js';

/**
 * Build the HTTP application without starting listeners or background jobs.
 * @returns {Object} The configured Express application.
 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(createRoutes());
  app.use(handleRequestError);

  return app;
}
