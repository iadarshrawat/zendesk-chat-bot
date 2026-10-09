import express from 'express';
import {
  generateZendeskJWT,
  generateIssues,
  generateReport,
  getInboxDiagnostics,
  handleSunshineMessage,
  livenessCheck,
  readinessCheck
} from '../controllers/index.js';
import { createWidgetAccess, requireReportKey, requireSiteIdentity, verifySunshineWebhook } from '../middlewares/index.js';

/**
 * Register the existing public routes with their original middleware and body limits.
 * @returns {Object} An Express router; endpoint paths and responses remain unchanged.
 */
export function createRoutes() {
  const router = express.Router();
  const { requireAllowedOrigin, widgetCors } = createWidgetAccess();

  router.get('/health/live', livenessCheck);
  router.get('/health/ready', readinessCheck);
  router.post('/sunshine/webhook', express.json({ limit: '256kb' }), verifySunshineWebhook, handleSunshineMessage);
  router.options('/sunshine/auth', requireAllowedOrigin, widgetCors);
  router.post('/sunshine/auth', requireAllowedOrigin, widgetCors, express.json({ limit: '1kb' }), requireSiteIdentity, generateZendeskJWT);
  router.get('/sunshine/report', requireReportKey, generateReport);
  router.get('/sunshine/monitoring/sessions', requireReportKey, generateReport);
  router.get('/sunshine/monitoring/issues', requireReportKey, generateIssues);
  router.get('/sunshine/inbox', requireReportKey, getInboxDiagnostics);

  return router;
}
