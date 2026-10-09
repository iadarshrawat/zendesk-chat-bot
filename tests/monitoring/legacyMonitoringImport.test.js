import test from 'node:test';
import assert from 'node:assert/strict';
import { importLegacyMonitoring, legacyMonitoringRecord } from '../../src/services/monitoring/historyImport.js';

function record(updated = '2026-10-02T12:00:00Z') {
  return {
    external_id: 'ai-monitor:v2:5687:message-1',
    updated_at: updated,
    custom_object_fields: {
      ticket_id: '5687',
      session_number: '1',
      session_first_message_id: 'message-1',
      session_started_at: '2026-10-02T08:00:00Z',
      session_last_customer_at: '2026-10-02T08:00:00Z',
      session_last_message_at: '2026-10-02T08:01:00Z',
      evaluation_due_at: '2026-10-02T10:00:00Z',
      evaluated_at: '2026-10-02T12:00:00Z',
      report_date: '2026-10-02',
      session_message_count: '2',
      csat_score: 'satisfied',
      reason: 'Solved',
      monitoring_status: 'evaluated',
      human_required: 'false',
      follow_up_required: 'true',
      confidence: 'high'
    }
  };
}

test('history conversion preserves original evaluation times, fields and boolean values', () => {
  const value = legacyMonitoringRecord(record());
  assert.equal(value.session_id, 'ai-monitor:v2:5687:message-1');
  assert.equal(value.evaluated_at, '2026-10-02T12:00:00Z');
  assert.equal(value.reason, 'Solved');
  assert.equal(value.human_required, 'false');
  assert.equal(legacyMonitoringRecord({ ...record(), external_id: 'unrelated' }), null);
});

test('paged history import is idempotent, keeps the newest duplicate, and never writes Zendesk', async () => {
  const stored = new Map();
  let requests = 0;
  const client = {
    async get(path, options) {
      assert.equal(path, '/custom_objects/ticket_csat_scores/records');
      requests++;
      if (!options.params['page[after]']) {
        return {
          data: {
            custom_object_records: [record()],
            meta: { has_more: true, after_cursor: 'next' }
          }
        };
      }

      return {
        data: {
          custom_object_records: [record('2026-10-02T11:00:00Z'), { external_id: 'other' }, { ...record(), custom_object_fields: {} }],
          meta: { has_more: false }
        }
      };
    }
  };
  const save = async (_db, value, options) => {
    assert.equal(options.replaceOlder, true);
    const previous = stored.get(value.session_id);
    if (previous && previous.updated_at >= value.updated_at) {
      return false;
    }
    stored.set(value.session_id, value);

    return true;
  };
  const first = await importLegacyMonitoring({ client, db: {}, save });
  assert.deepEqual(first, {
    read: 4,
    imported: 1,
    unchanged: 1,
    skipped: 2,
    invalid: 0
  });
  const second = await importLegacyMonitoring({ client, db: {}, save });
  assert.equal(second.imported, 0);
  assert.equal(stored.size, 1);
  assert.equal(stored.values().next().value.updated_at, '2026-10-02T12:00:00Z');
  assert.equal(requests, 4);
});

test('history import stops on a repeated cursor and reports malformed completed records', async () => {
  const bad = record();
  bad.custom_object_fields.session_started_at = 'invalid';
  const summary = await importLegacyMonitoring({
    db: {},
    client: {
      get: async () => ({
        data: {
          custom_object_records: [bad],
          meta: { has_more: false }
        }
      })
    }
  });
  assert.equal(summary.invalid, 1);
  await assert.rejects(
    importLegacyMonitoring({
      db: {},
      client: {
        get: async () => ({
          data: {
            custom_object_records: [],
            meta: { has_more: true, after_cursor: 'same' }
          }
        })
      }
    }),
    /did not advance/
  );
});
