/**
 * Read the configured custom object's escalation options.
 * @param {Object} client - Authenticated Zendesk client.
 * @param {string} objectKey - Existing category custom-object key.
 * @returns {Promise<Object>} The unmodified Axios response.
 */
export function fetchEscalationCategories(client, objectKey) {
  return client.get(`/custom_objects/${objectKey}/records.json`, {
    params: {}
  });
}

/**
 * Read a page of historical monitoring records for the explicit import command.
 * @param {Object} client - Authenticated Zendesk client.
 * @param {Object} params - Page size, sort order, and optional cursor.
 * @returns {Promise<Object>} The unmodified Axios response; never writes Zendesk data.
 */
export function fetchLegacyMonitoringRecords(client, params) {
  return client.get('/custom_objects/ticket_csat_scores/records', {
    params,
    timeout: 30_000
  });
}
