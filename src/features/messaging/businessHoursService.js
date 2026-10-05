import { createZendeskClient } from "../../config/zendesk.js";
import { logStage, measureStage } from "../../shared/timingLogger.js";
import { customerMessages } from "./customerMessages.js";

const DYNAMIC_CONTENT_ITEM_ID = process.env.ZENDESK_SCHEDULE_DYNAMIC_CONTENT_ID
  || process.env.DYNAMIC_CONTENT_ITEM_ID;
const BUSINESS_HOURS_SCHEDULE_ID = process.env.ZENDESK_BUSINESS_HOURS_SCHEDULE_ID;
const MINUTES_PER_DAY = 24 * 60;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Cache the Zendesk time_zone name -> IANA name lookup (from /time_zones.json)
// so we don't hit that endpoint on every single business-hours check.
let timeZoneMapCache = null;

async function getTimeZoneMap() {
  if (timeZoneMapCache) {
    logStage("zendesk.timezone_cache", { outcome: "hit" });
    return timeZoneMapCache;
  }

  logStage("zendesk.timezone_cache", { outcome: "miss" });

  const client = await createZendeskClient();
  const { data } = await measureStage(
    "zendesk.timezones",
    () => client.get("/time_zones.json"),
  );
  const timeZones = data?.time_zones || [];

  timeZoneMapCache = new Map(
    timeZones.map((timeZone) => [timeZone.name, timeZone.iana_name]),
  );
  return timeZoneMapCache;
}

async function resolveIanaTimeZone(zendeskTimeZoneName) {
  const map = await getTimeZoneMap();
  return map.get(zendeskTimeZoneName) || zendeskTimeZoneName;
}

async function getBusinessHoursSchedule() {
  const client = await createZendeskClient();
  const scheduleId = BUSINESS_HOURS_SCHEDULE_ID;

  if (!scheduleId) {
    throw new Error("Zendesk Business Hours schedule ID is not configured");
  }

  const { data } = await measureStage(
    "zendesk.business_hours_schedule",
    () => client.get(`/business_hours/schedules/${scheduleId}.json`),
  );
  const schedule = data?.schedule;

  if (!schedule?.intervals?.length) {
    throw new Error(`Business Hours schedule ${scheduleId} not found or has no intervals`);
  }

  return schedule;
}

function getMinutesSinceWeekStart(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
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
    console.error("Unable to resolve time zone for business hours check:", error.message);
    return null;
  }
}

async function isWithinScheduleIntervals(schedule, date) {
  const ianaTimeZone = await resolveIanaTimeZone(schedule.time_zone);
  const currentMinutes = getMinutesSinceWeekStart(date, ianaTimeZone);

  if (currentMinutes === null) {
    return false;
  }

  return schedule.intervals.some(
    ({ start_time, end_time }) => currentMinutes >= start_time && currentMinutes < end_time
  );
}

async function getUnavailableMessageFromDynamicContent() {
  const client = await createZendeskClient();
  const itemId = DYNAMIC_CONTENT_ITEM_ID;

  if (!itemId) {
    throw new Error("Zendesk Dynamic Content item ID is not configured");
  }

  const { data } = await measureStage(
    "zendesk.unavailable_message",
    () => client.get(`/dynamic_content/items/${itemId}.json`),
  );
  const variants = data?.item?.variants || [];
  const variant = variants.find((item) => item.default && item.active)
    || variants.find((item) => item.active);

  if (!variant?.content?.trim()) {
    throw new Error(`Dynamic Content item ${itemId} has no active timing content`);
  }

  return variant.content.trim();
}

export async function isWithinBusinessHours(date = new Date()) {
  try {
    const schedule = await getBusinessHoursSchedule();
    const withinHours = await isWithinScheduleIntervals(schedule, date);
    const message = withinHours ? null : await getBusinessHoursUnavailableMessage();

    return { withinHours, message };
  } catch (error) {
    console.error("Unable to check agent availability from Business Hours:", error.message);
    const message = await getBusinessHoursUnavailableMessage();
    return { withinHours: false, message };
  }
}

export async function getBusinessHoursUnavailableMessage() {
  const fallbackMessage = process.env.BUSINESS_HOURS_UNAVAILABLE_MESSAGE
    || customerMessages.outsideHours;

  try {
    return await getUnavailableMessageFromDynamicContent();
  } catch (error) {
    console.error("Unable to fetch Dynamic Content unavailable message:", error.message);
    return fallbackMessage;
  }
}
