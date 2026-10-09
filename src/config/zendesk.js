import dotenv from 'dotenv';

dotenv.config();

export const ZENDESK_CONFIG = {
  subdomain: process.env.ZENDESK_SUBDOMAIN || '',
  clientId: process.env.ZENDESK_CLIENT_ID || '',
  clientSecret: process.env.ZENDESK_CLIENT_SECRET || '',
  baseUrl: process.env.ZENDESK_SUBDOMAIN ? `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com` : null
};
