import test from 'node:test';
import assert from 'node:assert/strict';
import { createIssuesController, createReportController } from '../../src/controllers/monitoring/index.js';
import { reportFilters } from '../../src/middlewares/validation/monitoring/index.js';
import { sessionFromRow, summarizeSessions } from '../../src/common/monitoring/reportData.js';
import { monitoringIssues, monitoringPage } from '../../src/models/monitoring/index.js';

function row(id = 'message-1') {
  return {
    session_id: `ai-monitor:v2:5687:${id}`,
    ticket_id: '5687',
    session_number: 1,
    report_date: new Date('2026-10-02T00:00:00Z'),
    updated_at: new Date('2026-10-02T12:00:00Z'),
    evaluated_at: new Date('2026-10-02T12:00:00Z'),
    ticket_subject: 'Fan support',
    score: 'satisfied'
  };
}

function response() {
  return {
    statusCode: 200,
    status(value) {
      this.statusCode = value;

      return this;
    },
    set() {
      return this;
    },
    json(value) {
      this.body = value;

      return this;
    }
  };
}

test('report serializes SQL timestamps and calculates page-scoped satisfaction', () => {
  const session = sessionFromRow(row());
  assert.equal(session.report_date, '2026-10-02');
  assert.equal(session.evaluated_at, '2026-10-02T12:00:00.000Z');
  assert.equal(session.record_id, session.session_id);
  assert.equal(session.issue_type, 'unknown');
  assert.equal(sessionFromRow({ ...row(), issue_type: 'payment' }).issue_type, 'payment');
  const summary = summarizeSessions([session]);
  assert.equal(summary.csat_percent, 100);
  assert.equal(summary.scope, 'page');
  assert.equal(Object.hasOwn(summary, 'resolution_breakdown'), false);
});

test('issue counts cover the full search, rank by frequency, and keep legacy sessions under unknown', async () => {
  let receivedFilters;
  const controller = createIssuesController({
    db: {},
    readIssues: async (_db, filters) => {
      receivedFilters = filters;

      return [
        { issue_type: 'returns_refunds', session_count: '3' },
        { issue_type: null, session_count: '7' },
        { issue_type: 'product_information', session_count: '25' }
      ];
    }
  });
  const res = response();
  await controller(
    {
      query: {
        from: '2026-10-01',
        to: '2026-10-07',
        score: 'neutral',
        search: ' product ',
        cursor: 'ignored',
        limit: '1'
      }
    },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.scope, 'search');
  assert.equal(res.body.total_sessions, 35);
  assert.deepEqual(
    res.body.issues.map(issue => [issue.issue_type, issue.session_count, issue.percentage]),
    [
      ['product_information', 25, 71.4],
      ['unknown', 7, 20],
      ['returns_refunds', 3, 8.6]
    ]
  );
  assert.equal(receivedFilters.after, null);
  assert.equal(receivedFilters.search, 'product');
  assert.equal(receivedFilters.score, 'neutral');
});

test('issues reject invalid filters before SQL and return empty or generic failure responses', async () => {
  let reads = 0;
  const controller = createIssuesController({
    db: {},
    readIssues: async () => {
      reads++;

      return [];
    }
  });
  const invalid = response();
  await controller({ query: { from: 'bad' } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(reads, 0);
  const empty = response();
  await controller({ query: { from: '2026-10-01', to: '2026-10-07' } }, empty);
  assert.equal(empty.body.total_sessions, 0);
  assert.deepEqual(empty.body.issues, []);
  const failed = response();
  await createIssuesController({
    db: {},
    readIssues: async () => {
      throw new Error('private SQL details');
    }
  })({ query: { from: '2026-10-01', to: '2026-10-07' } }, failed);
  assert.equal(failed.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(failed.body), /private SQL/);
});

test('issue SQL shares literal text and score filters with sessions and has no pagination', async () => {
  let query;
  const values = {};
  const db = {
    request: () => ({
      input(name, _type, value) {
        values[name] = value;

        return this;
      },
      cancel() {},
      async query(value) {
        query = value;

        return { recordset: [] };
      }
    })
  };
  await monitoringIssues(db, {
    from: '2026-10-01',
    to: '2026-10-07',
    score: 'satisfied',
    search: "50%_[x]~'; DROP TABLE users;--",
    limit: 1,
    after: { session_id: 'ignored' }
  });
  assert.match(query, /GROUP BY COALESCE\(e.issue_type, 'unknown'\)/);
  assert.match(query, /ORDER BY session_count DESC, issue_type ASC/);
  assert.doesNotMatch(query, /TOP|@after|@rowLimit|DROP TABLE users/);
  assert.equal(values.score, 'satisfied');
  assert.match(values.pattern, /50~%~_~\[x\]~~/);
  assert.equal(values.afterId, undefined);
  assert.ok(values.from instanceof Date);
});

test('date, score, search, page size and cursor are validated before SQL', () => {
  const query = { from: '2026-10-01', to: '2026-10-02' };
  for (const invalid of [
    { from: '2026-02-30' },
    { from: '2026-10-03' },
    { from: '2024-10-01' },
    { score: 'bad' },
    { search: 'x'.repeat(201) },
    { limit: '101' },
    { limit: '0' },
    { limit: '1; DROP TABLE sessions' },
    { cursor: 'not-json' }
  ]) {
    assert.throws(() => reportFilters({ ...query, ...invalid }), TypeError);
  }
  assert.equal(reportFilters(query).limit, 20);
  assert.equal(reportFilters({ from: '2024-02-29', to: '2025-02-28' }).limit, 20);
  assert.throws(() => reportFilters({ from: '2024-02-29', to: '2025-03-01' }));
});

test('SQL report generates a next cursor tied to the same search filters', async () => {
  const query = { from: '2026-10-01', to: '2026-10-03', search: 'fan' };
  const calls = [];
  const controller = createReportController({
    db: {},
    readPage: async (_db, filters) => {
      calls.push(filters);

      return { rows: [row()], hasMore: !filters.after };
    }
  });
  const first = response();
  await controller({ query }, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.sessions.length, 1);
  assert.equal(first.body.pagination.has_more, true);
  const second = response();
  await controller({ query: { ...query, cursor: first.body.pagination.next_cursor } }, second);
  assert.equal(second.body.pagination.next_cursor, null);
  assert.equal(calls[1].after.session_id, 'ai-monitor:v2:5687:message-1');
  const changedSearch = response();
  await controller(
    {
      query: {
        ...query,
        search: 'heater',
        cursor: first.body.pagination.next_cursor
      }
    },
    changedSearch
  );
  assert.equal(changedSearch.statusCode, 400);
  assert.equal(calls.length, 2);
});

test('SQL filtering uses bounded typed parameters and treats LIKE characters literally', async () => {
  let query;
  const values = {};
  const db = {
    request: () => ({
      input(name, _type, value) {
        values[name] = value;

        return this;
      },
      cancel() {},
      async query(value) {
        query = value;

        return { recordset: [row('one'), row('two')] };
      }
    })
  };
  const result = await monitoringPage(db, {
    from: '2026-10-01',
    to: '2026-10-03',
    score: 'satisfied',
    search: "50%_[x]~'; DROP TABLE users;--",
    limit: 1,
    after: null
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.hasMore, true);
  assert.equal(values.rowLimit, 2);
  assert.match(values.pattern, /50~%~_~\[x\]~~/);
  assert.doesNotMatch(query, /DROP TABLE users/);
  assert.match(query, /INNER JOIN .*bot_monitor_sessions/);
  assert.match(query, /ORDER BY e.report_date DESC, e.updated_at DESC, e.session_id DESC/);
});

test('database failure returns a generic 503 without SQL details', async () => {
  const controller = createReportController({
    db: {},
    readPage: async () => {
      throw new Error('private SQL details');
    }
  });
  const res = response();
  await controller({ query: { from: '2026-10-01', to: '2026-10-02' } }, res);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /private SQL/);
});
