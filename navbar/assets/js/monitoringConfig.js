// js/: public display settings. Credentials belong in Zendesk's secure installation settings.
export const MONITORING_API = { hostname: "", pageSize: 15 };

/**
 * Read and validate the public backend hostname without reading the secure API key.
 * @param {Object} client - Zendesk SDK client for the installed app.
 * @returns {Promise<void>} Stores the hostname; rejects if installation settings are missing or invalid.
 */
export async function configureMonitoringApi(client) {
  const metadata = await client.metadata();
  const hostname = String(
    metadata?.settings?.monitoring_api_hostname || "",
  ).trim();
  const validHostname =
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  if (hostname.length > 253 || !validHostname.test(hostname)) {
    throw new Error(
      "Configure the monitoring API hostname in the app's installation settings. Enter a hostname without https://, a port, or a path.",
    );
  }
  MONITORING_API.hostname = hostname;
}
