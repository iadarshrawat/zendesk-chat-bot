import { createZendeskClient } from '../../api/zendesk/client.js';
import { fetchTimeZones, fetchBusinessHoursSchedule, fetchDynamicContentItem } from '../../api/zendesk/businessHours.js';
import { logStage, measureStage } from '../../common/utils/timingLogger.js';
import { customerMessages } from '../../lib/message/index.js';

const DYNAMIC_CONTENT_ITEM_ID = process.env.ZENDESK_SCHEDULE_DYNAMIC_CONTENT_ID || process.env.DYNAMIC_CONTENT_ITEM_ID;
const BUSINESS_HOURS_SCHEDULE_ID = process.env.ZENDESK_BUSINESS_HOURS_SCHEDULE_ID;
const MINUTES_PER_DAY = 24 * 60;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Cache the Zendesk time_zone name -> IANA name lookup (from /time_zones.json)
// so we don't hit that endpoint on every single business-hours check.
let timeZoneMapCache = null;

/**
 * Cache Zendesk's time-zone names and their IANA equivalents for business-hours checks.
 * @returns {Promise<Map>} The process-local time-zone lookup.
 */
async function getTimeZoneMap() {
  if (timeZoneMapCache) {
    logStage('zendesk.timezone_cache', { outcome: 'hit' });

    return timeZoneMapCache;
  }

  logStage('zendesk.timezone_cache', { outcome: 'miss' });

  const client = await createZendeskClient();
  const { data } = await measureStage('zendesk.timezones', () => fetchTimeZones(client));
  const timeZones = data?.time_zones || [];

  timeZoneMapCache = new Map(timeZones.map(timeZone => [timeZone.name, timeZone.iana_name]));

  return timeZoneMapCache;
}

async function resolveIanaTimeZone(zendeskTimeZoneName) {
  const map = await getTimeZoneMap();

  return map.get(zendeskTimeZoneName) || zendeskTimeZoneName;
}

/**
 * Read the configured Zendesk schedule and require its existing intervals.
 * @returns {Promise<Object>} The schedule; rejects for missing configuration or empty intervals.
 */
async function getBusinessHoursSchedule() {
  const client = await createZendeskClient();
  const scheduleId = BUSINESS_HOURS_SCHEDULE_ID;

  if (!scheduleId) {
    throw new Error('Zendesk Business Hours schedule ID is not configured');
  }

  const { data } = await measureStage('zendesk.business_hours_schedule', () => fetchBusinessHoursSchedule(client, scheduleId));
  const schedule = data?.schedule;

  if (!schedule?.intervals?.length) {
    throw new Error(`Business Hours schedule ${scheduleId} not found or has no intervals`);
  }

  return schedule;
}

/**
 * Convert a date to the schedule's local weekday and minute offset.
 * @param {Date} date - Time to compare with the configured schedule.
 * @param {string} timeZone - IANA time-zone name.
 * @returns {number|null} Minutes since Sunday midnight, or null for an invalid time zone.
 */
function getMinutesSinceWeekStart(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23'
    }).formatToParts(date);

    const dateParts = {};
    for (const part of parts) {
      dateParts[part.type] = part.value;
    }

    const weekdayIndex = WEEKDAYS.indexOf(dateParts.weekday);
    if (weekdayIndex === -1) {
      return null;
    }

    const hours = parseInt(dateParts.hour, 10);
    const minutes = parseInt(dateParts.minute, 10);

    return weekdayIndex * MINUTES_PER_DAY + hours * 60 + minutes;
  } catch (error) {
    console.error('Unable to resolve time zone for business hours check:', error.message);

    return null;
  }
}

/**
 * Check whether a date falls within one of the schedule's local-time intervals.
 * @param {Object} schedule - Zendesk business-hours schedule.
 * @param {Date} date - Time to compare with the configured schedule.
 * @returns {Promise<boolean>} Whether the date is inside business hours.
 */
async function isWithinScheduleIntervals(schedule, date) {
  const ianaTimeZone = await resolveIanaTimeZone(schedule.time_zone);
  const currentMinutes = getMinutesSinceWeekStart(date, ianaTimeZone);

  if (currentMinutes === null) {
    return false;
  }

  return schedule.intervals.some(({ start_time, end_time }) => currentMinutes >= start_time && currentMinutes < end_time);
}

/**
 * Select the active default or first active Zendesk timing-message variant.
 * @returns {Promise<string>} Trimmed message content; rejects if no valid variant exists.
 */
async function getUnavailableMessageFromDynamicContent() {
  const client = await createZendeskClient();
  const itemId = DYNAMIC_CONTENT_ITEM_ID;

  if (!itemId) {
    throw new Error('Zendesk Dynamic Content item ID is not configured');
  }

  const { data } = await measureStage('zendesk.unavailable_message', () => fetchDynamicContentItem(client, itemId));
  const variants = data?.item?.variants || [];
  const variant = variants.find(item => item.default && item.active) || variants.find(item => item.active);

  if (!variant?.content?.trim()) {
    throw new Error(`Dynamic Content item ${itemId} has no active timing content`);
  }

  return variant.content.trim();
}

/**
 * Check agent availability and preserve the existing outside-hours fallback on API failures.
 * @param {Date} date - Time to compare with the configured schedule.
 * @returns {Promise<Object>} withinHours and the unavailable message when applicable.
 */
export async function isWithinBusinessHours(date = new Date()) {
  try {
    const schedule = await getBusinessHoursSchedule();
    const withinHours = await isWithinScheduleIntervals(schedule, date);
    const message = withinHours ? null : await getBusinessHoursUnavailableMessage();

    return { withinHours, message };
  } catch (error) {
    console.error('Unable to check agent availability from Business Hours:', error.message);
    const message = await getBusinessHoursUnavailableMessage();

    return { withinHours: false, message };
  }
}

/**
 * Load the configured dynamic-content message or use the existing environment fallback.
 * @returns {Promise<string>} The message shown when human support is unavailable.
 */
async function getBusinessHoursUnavailableMessage() {
  const fallbackMessage = process.env.BUSINESS_HOURS_UNAVAILABLE_MESSAGE || customerMessages.outsideHours;

  try {
    return await getUnavailableMessageFromDynamicContent();
  } catch (error) {
    console.error('Unable to fetch Dynamic Content unavailable message:', error.message);

    return fallbackMessage;
  }
}
