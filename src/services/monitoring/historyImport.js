import { monitoringRecord, SESSION_GAP_MS } from '../../common/monitoring/index.js';
import { saveMonitoringSession } from '../../models/monitoring/index.js';
import { fetchLegacyMonitoringRecords } from '../../api/zendesk/customObjects.js';

/**
 * Normalize an eligible historical custom-object record for the explicit SQL import.
 * @param {Object} record - Monitoring data to validate.
 * @returns {Object|null} The validated import record, or null when its identity or status is ineligible.
 */
export function legacyMonitoringRecord(record) {
  const identity = /^ai-monitor:v2:(\d+):(.+)$/.exec(record.external_id || '');
  const fields = record.custom_object_fields || {};
  if (!identity || !['evaluated', 'escalated'].includes(fields.monitoring_status)) {
    return null;
  }
  const evaluatedAt = fields.evaluated_at;
  const customerAt = fields.session_last_customer_at || fields.session_last_message_at;
  const value = {
    session_id: record.external_id,
    ticket_id: String(fields.ticket_id ?? identity[1]),
    session_number: fields.session_number,
    ticket_subject: fields.ticket_subject || '',
    ticket_created_at: fields.ticket_created_at || null,
    ticket_requester_id: fields.ticket_requester_id || null,
    first_message_id: fields.session_first_message_id || identity[2],
    session_started_at: fields.session_started_at,
    last_customer_at: customerAt,
    last_message_at: fields.session_last_message_at || customerAt,
    message_count: fields.session_message_count ?? 0,
    evaluation_due_at: fields.evaluation_due_at || new Date(Date.parse(customerAt) + SESSION_GAP_MS).toISOString(),
    evaluated_at: evaluatedAt,
    report_date: fields.report_date || evaluatedAt?.slice(0, 10),
    csat_score: fields.csat_score,
    reason: fields.reason || '',
    monitoring_status: fields.monitoring_status,
    confidence: fields.confidence || null,
    human_required: fields.human_required,
    follow_up_required: fields.follow_up_required,
    key_issue: fields.key_issue || null,
    updated_at: record.updated_at || evaluatedAt
  };
  monitoringRecord(value);

  return value;
}

/**
 * Read historical records without changing Zendesk and import only new or explicitly newer SQL results.
 * @param {Object} options - Options: client, db, save.
 * @returns {Promise<Object>} Read, imported, unchanged, skipped, and invalid record counts.
 */
export async function importLegacyMonitoring({ client, db, save = saveMonitoringSession }) {
  const summary = {
    read: 0,
    imported: 0,
    unchanged: 0,
    skipped: 0,
    invalid: 0
  };
  let cursor;
  const seen = new Set();
  while (true) {
    const params = { 'page[size]': 100, sort: '-updated_at' };
    if (cursor) {
      params['page[after]'] = cursor;
    }
    const response = await fetchLegacyMonitoringRecords(client, params);
    const data = response.data || {};
    for (const record of data.custom_object_records || []) {
      summary.read += 1;
      let value;
      try {
        value = legacyMonitoringRecord(record);
      } catch {
        summary.invalid += 1;
        continue;
      }
      if (!value) {
        summary.skipped += 1;
        continue;
      }
      // Newest historical duplicate wins; existing newer SQL results remain.
      const changed = await save(db, value, { replaceOlder: true });
      summary[changed ? 'imported' : 'unchanged'] += 1;
    }
    if (!data.meta?.has_more) {
      return summary;
    }
    const next = data.meta.after_cursor;
    if (!next || seen.has(next)) {
      throw new Error('Legacy monitoring pagination did not advance');
    }
    seen.add(next);
    cursor = next;
  }
}
