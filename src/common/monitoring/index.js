import { validReportDate } from '../utils/dates.js';

export const SESSION_GAP_MS = 2 * 60 * 60 * 1000;
export const MONITORING_SCORES = ['satisfied', 'neutral', 'unsatisfied', 'escalated', 'insufficient_data'];
const MONITORING_STATUSES = ['evaluated', 'escalated'];
export const MONITORING_ISSUE_TYPES = [
  'product_information',
  'order_status',
  'delivery',
  'returns_refunds',
  'payment',
  'account',
  'technical_support',
  'other',
  'unknown'
];

/**
 * Validate the primary customer topic; older records have no recorded category.
 * @param {string|null|undefined} value - Stored or generated issue category.
 * @returns {string} A supported issue type, or unknown for a missing value.
 */
export function monitoringIssueType(value) {
  if (value == null || value === '') {
    return 'unknown';
  }
  if (!MONITORING_ISSUE_TYPES.includes(value)) {
    throw new TypeError('Invalid monitoring issue type');
  }

  return value;
}

function date(value, name, optional = false) {
  if (optional && (value == null || value === '')) {
    return null;
  }
  const result = new Date(value);
  if (value == null || value === '' || !Number.isFinite(result.getTime())) {
    throw new TypeError(`Invalid monitoring ${name}`);
  }

  return result;
}

function text(value, limit, name, optional = false) {
  if (optional && (value == null || value === '')) {
    return null;
  }
  const result = String(value ?? '').trim();
  if (result.length > limit) {
    throw new TypeError(`Monitoring ${name} exceeds ${limit} characters`);
  }

  return result;
}

/**
 * Normalize a stored monitoring flag and reject unsupported values.
 * @param {boolean|number|string|null} value - Boolean value, 1/0, or its supported string form.
 * @returns {boolean|null} The flag, or null when no value was recorded.
 */
function boolean(value) {
  if (value == null || value === '') {
    return null;
  }
  if ([true, 1, 'true', '1'].includes(value)) {
    return true;
  }
  if ([false, 0, 'false', '0'].includes(value)) {
    return false;
  }
  throw new TypeError('Invalid monitoring boolean');
}

/**
 * Validate session identity, counts, timeline, scores, and optional fields before SQL persistence.
 * @param {Object} record - Monitoring data to validate.
 * @returns {Object} Normalized SQL values; throws before writes for an invalid record.
 */
export function monitoringRecord(record) {
  const ticketId = text(record.ticket_id, 32, 'ticket_id');
  const sessionId = text(record.session_id, 255, 'session_id');
  const identity = /^ai-monitor:v2:(\d+):(.+)$/.exec(sessionId);
  const firstMessageId = text(record.first_message_id, 128, 'first_message_id');
  const sessionNumber = Number(record.session_number);
  const messageCount = Number(record.message_count);
  if (
    !identity ||
    identity[1] !== ticketId ||
    identity[2] !== firstMessageId ||
    !Number.isSafeInteger(sessionNumber) ||
    sessionNumber < 1 ||
    !Number.isSafeInteger(messageCount) ||
    messageCount < 0
  ) {
    throw new TypeError('Invalid monitoring session identity or counts');
  }
  if (
    !MONITORING_SCORES.includes(record.csat_score) ||
    !MONITORING_STATUSES.includes(record.monitoring_status) ||
    !validReportDate(record.report_date)
  ) {
    throw new TypeError('Invalid monitoring evaluation');
  }
  const confidence = record.confidence || null;
  if (confidence && !['high', 'medium', 'low'].includes(confidence)) {
    throw new TypeError('Invalid monitoring confidence');
  }
  const startedAt = date(record.session_started_at, 'session_started_at');
  const customerAt = date(record.last_customer_at, 'last_customer_at');
  const messageAt = date(record.last_message_at, 'last_message_at');
  const dueAt = date(record.evaluation_due_at, 'evaluation_due_at');
  const evaluatedAt = date(record.evaluated_at, 'evaluated_at');
  if (customerAt < startedAt || messageAt < customerAt || dueAt < customerAt || evaluatedAt < dueAt) {
    throw new TypeError('Invalid monitoring session timeline');
  }

  return {
    session_id: sessionId,
    ticket_id: ticketId,
    session_number: sessionNumber,
    ticket_subject: text(record.ticket_subject, 1024, 'ticket_subject'),
    ticket_created_at: date(record.ticket_created_at, 'ticket_created_at', true),
    ticket_requester_id: text(record.ticket_requester_id, 128, 'ticket_requester_id', true),
    first_message_id: firstMessageId,
    session_started_at: startedAt,
    last_customer_at: customerAt,
    last_message_at: messageAt,
    message_count: messageCount,
    evaluation_due_at: dueAt,
    evaluated_at: evaluatedAt,
    report_date: new Date(`${record.report_date}T00:00:00Z`),
    csat_score: record.csat_score,
    reason: text(record.reason, 4000, 'reason'),
    monitoring_status: record.monitoring_status,
    confidence,
    human_required: boolean(record.human_required),
    follow_up_required: boolean(record.follow_up_required),
    key_issue: text(record.key_issue, 1024, 'key_issue', true),
    issue_type: monitoringIssueType(record.issue_type),
    updated_at: date(record.updated_at ?? record.evaluated_at, 'updated_at')
  };
}
