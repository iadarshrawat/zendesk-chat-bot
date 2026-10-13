import 'dotenv/config';

const MILLISECONDS_PER_MINUTE = 60 * 1000;
const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE;

/**
 * Read a positive duration setting and convert its configured unit to milliseconds.
 * @param {string} name - Environment variable name.
 * @param {number} defaultValue - Value used when the setting is missing or empty.
 * @param {number} millisecondsPerUnit - Milliseconds in one hour or minute.
 * @param {string} unit - Unit name used in validation errors.
 * @returns {number} Duration in milliseconds; throws for an invalid configured value.
 */
function durationInMilliseconds(name, defaultValue, millisecondsPerUnit, unit) {
  const value = process.env[name]?.trim();
  const duration = value ? Number(value) : defaultValue;
  const milliseconds = Math.round(duration * millisecondsPerUnit);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new Error(`${name} must be a positive number of ${unit}`);
  }

  return milliseconds;
}

export const MONITORING_CONFIG = {
  sessionIdleMs: durationInMilliseconds('MONITOR_SESSION_IDLE_HOURS', 2, MILLISECONDS_PER_HOUR, 'hours'),
  lookbackMs: durationInMilliseconds('MONITOR_LOOKBACK_HOURS', 5, MILLISECONDS_PER_HOUR, 'hours'),
  pollIntervalMs: durationInMilliseconds('MONITOR_POLL_INTERVAL_MINUTES', 5, MILLISECONDS_PER_MINUTE, 'minutes')
};

if (MONITORING_CONFIG.pollIntervalMs < 1_000) {
  throw new Error('MONITOR_POLL_INTERVAL_MINUTES must represent at least one second');
}

// A quiet session must still be inside the ticket window when it becomes due.
if (MONITORING_CONFIG.lookbackMs <= MONITORING_CONFIG.sessionIdleMs) {
  throw new Error('MONITOR_LOOKBACK_HOURS must be greater than MONITOR_SESSION_IDLE_HOURS');
}
