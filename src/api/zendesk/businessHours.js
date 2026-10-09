/**
 * Read Zendesk's time-zone name to IANA-name lookup.
 * @param {Object} client - Authenticated Zendesk client.
 * @returns {Promise<Object>} The unmodified Axios response.
 */
export function fetchTimeZones(client) {
  return client.get('/time_zones.json');
}

/**
 * Read the configured business-hours schedule.
 * @param {Object} client - Authenticated Zendesk client.
 * @param {string} scheduleId - Existing schedule ID.
 * @returns {Promise<Object>} The unmodified Axios response.
 */
export function fetchBusinessHoursSchedule(client, scheduleId) {
  return client.get(`/business_hours/schedules/${scheduleId}.json`);
}

/**
 * Read the dynamic-content item containing the outside-hours message.
 * @param {Object} client - Authenticated Zendesk client.
 * @param {string} itemId - Existing dynamic-content item ID.
 * @returns {Promise<Object>} The unmodified Axios response.
 */
export function fetchDynamicContentItem(client, itemId) {
  return client.get(`/dynamic_content/items/${itemId}.json`);
}
