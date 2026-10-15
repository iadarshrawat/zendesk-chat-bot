import { assertBrandRoutingConfigured } from '../brands/index.js';
import { assertRagConfigured } from '../rag/index.js';

/**
 * Validate brand routing, knowledge retrieval, and mandatory messaging credentials at startup.
 * @returns {void} Returns normally when configured; otherwise throws the missing-setting error.
 */
export function assertRuntimeConfiguration() {
  assertBrandRoutingConfigured();
  assertRagConfigured();

  const required = [
    'SUNSHINE_KEY_ID',
    'SUNSHINE_KEY_SECRET',
    'SUNSHINE_APP_ID',
    'SUNSHINE_WEBHOOK_SECRET',
    'ANTHROPIC_API_KEY',
    'ZENDESK_SUBDOMAIN',
    'ZENDESK_CLIENT_ID',
    'ZENDESK_CLIENT_SECRET',
    'ZENDESK_BUSINESS_HOURS_SCHEDULE_ID'
  ];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length) {
    throw new Error(`Missing configuration: ${missing.join(', ')}`);
  }
  if (process.env.NODE_ENV === 'production' && !/^\S{32,1024}$/.test(process.env.REPORT_API_KEY || '')) {
    throw new Error('Production requires REPORT_API_KEY with 32–1024 characters and no whitespace');
  }
}
