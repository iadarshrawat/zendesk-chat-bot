import test from "node:test";
import assert from "node:assert/strict";
import {
  databaseSchema,
  initializeCoreSchema,
  sqlTable,
  verifyCoreSchema,
} from "./schema.js";
import { sqlServerConfig } from "./sql.js";

function conversationStateDefinition() {
  return {
    columns: [
      column("conversation_id", "nvarchar", { maxLength: 256 }),
      column("state_json", "nvarchar", { maxLength: -1 }),
      column("updated_at", "datetime2", { scale: 3 }),
    ],
    indexes: [
      index("PK_bot_conversation_state", "conversation_id", { primaryKey: true }),
      index("idx_bot_state_updated", "updated_at"),
    ],
    checks: [{
      constraint_name: "CK_bot_conversation_state_state_json",
      definition: "(isjson([state_json])=(1))",
      is_disabled: false,
      is_not_trusted: false,
    }],
  };
}

function monitorSessionsDefinition() {
  return {
    columns: [
      column("session_id", "nvarchar", { maxLength: 510 }),
      column("ticket_id", "nvarchar", { maxLength: 64 }),
      column("session_started_at", "datetime2", { scale: 3 }),
      column("last_customer_at", "datetime2", { scale: 3 }),
      column("record_external_id", "nvarchar", { maxLength: 510 }),
      column("evaluated_at", "datetime2", { scale: 3 }),
    ],
    indexes: [
      index("PK_bot_monitor_sessions", "session_id", { primaryKey: true }),
      index("idx_bot_monitor_ticket", "ticket_id"),
    ],
    checks: [],
  };
}

function monitorEvaluationsDefinition() {
  const columns = [
    column("session_id", "nvarchar", { maxLength: 510 }), column("session_number", "int"),
    column("ticket_subject", "nvarchar", { maxLength: 2048 }),
    column("ticket_created_at", "datetime2", { scale: 3, nullable: true }),
    column("ticket_requester_id", "nvarchar", { maxLength: 256, nullable: true }),
    column("first_message_id", "nvarchar", { maxLength: 256 }),
    column("last_message_at", "datetime2", { scale: 3 }), column("message_count", "int"),
    column("evaluation_due_at", "datetime2", { scale: 3 }), column("report_date", "date"),
    column("csat_score", "varchar", { maxLength: 32 }), column("reason", "nvarchar", { maxLength: 8000 }),
    column("monitoring_status", "varchar", { maxLength: 16 }),
    column("confidence", "varchar", { maxLength: 8, nullable: true }),
    column("human_required", "bit", { nullable: true }), column("follow_up_required", "bit", { nullable: true }),
    column("key_issue", "nvarchar", { maxLength: 2048, nullable: true }),
    column("updated_at", "datetime2", { scale: 3 }),
  ];
  return { columns,
    indexes: [index("PK_bot_monitor_evaluations", "session_id", { primaryKey: true }),
      ...["report_date", "updated_at", "session_id"].map((name, i) => ({ ...index("idx_bot_monitor_report", name), key_ordinal: i + 1 }))],
    checks: ["score", "status", "confidence", "counts"].map(name => ({
      constraint_name: `CK_bot_monitor_evaluations_${name}`, is_disabled: false, is_not_trusted: false,
    })),
    foreignKeys: [{ constraint_name: "FK_bot_monitor_evaluations_session", column_name: "session_id",
      referenced_table: "bot_monitor_sessions", referenced_column: "session_id",
      is_disabled: false, is_not_trusted: false }],
  };
}

function column(name, type, { maxLength = 0, scale = 0, nullable = false } = {}) {
  return {
    column_name: name,
    data_type: type,
    max_length: maxLength,
    scale,
    is_nullable: nullable,
    is_identity: false,
    is_computed: false,
  };
}

function index(name, columnName, { primaryKey = false } = {}) {
  return {
    index_name: name,
    is_primary_key: primaryKey,
    is_unique: primaryKey,
    is_disabled: false,
    has_filter: false,
    key_ordinal: 1,
    is_included_column: false,
    column_name: columnName,
  };
}

function createDatabase({ schemaExists = true, tables = new Map(), queryError } = {}) {
  const batches = [];
  const queries = [];

  return {
    batches,
    queries,
    request() {
      const parameters = {};

      return {
        input(name, value) {
          parameters[name] = value;
          return this;
        },
        async query(sql) {
          queries.push({ sql, parameters: { ...parameters } });
          if (queryError) throw queryError;

          if (sql.includes("SCHEMA_ID")) {
            return { recordset: [{ schema_id: schemaExists ? 1 : null }] };
          }

          const definition = tables.get(parameters.tableName);
          if (sql.includes("FROM sys.foreign_keys")) {
            return { recordset: (definition?.foreignKeys || []).map(row => ({ ...row, referenced_schema: parameters.schemaName })) };
          }
          if (sql.includes("FROM sys.tables AS tables") && !sql.includes("sys.columns")) {
            return { recordset: definition ? [{ object_id: 1 }] : [] };
          }
          if (sql.includes("FROM sys.columns AS columns")) {
            return { recordset: definition?.columns ?? [] };
          }
          if (sql.includes("FROM sys.indexes AS indexes")) {
            return { recordset: definition?.indexes ?? [] };
          }
          if (sql.includes("FROM sys.check_constraints AS checks")) {
            return { recordset: definition?.checks ?? [] };
          }

          throw new Error(`Unexpected query: ${sql}`);
        },
        async batch(sql) {
          batches.push(sql);
          if (!tables.has("bot_conversation_state")) tables.set("bot_conversation_state", conversationStateDefinition());
          if (!tables.has("bot_monitor_sessions")) tables.set("bot_monitor_sessions", monitorSessionsDefinition());
          if (!tables.has("bot_monitor_evaluations")) tables.set("bot_monitor_evaluations", monitorEvaluationsDefinition());
          return { rowsAffected: [] };
        },
      };
    },
  };
}

test("explicit migration creates only the three approved SQL Server tables", async () => {
  const db = createDatabase();

  assert.equal(await initializeCoreSchema(db, "support"), true);
  assert.equal(db.batches.length, 1);

  const migration = db.batches[0];
  const createdTables = [...migration.matchAll(/CREATE TABLE \[support]\.\[([^\]]+)]/g)]
    .map((match) => match[1]);

  assert.deepEqual(createdTables, [
    "bot_conversation_state",
    "bot_monitor_sessions",
    "bot_monitor_evaluations",
  ]);
  assert.doesNotMatch(migration, /\bbot_(?:inbox|forms)\b/i);
  assert.doesNotMatch(migration, /\b(?:DROP|ALTER)\b/i);
  assert.equal(migration.includes("{{schema}}"), false);

  assert.equal(await initializeCoreSchema(db, "support"), false);
  assert.equal(db.batches.length, 1);

  const inspectedTables = db.queries
    .map(({ parameters }) => parameters.tableName)
    .filter(Boolean);
  assert.ok(inspectedTables.every((name) => [
    "bot_conversation_state",
    "bot_monitor_sessions",
    "bot_monitor_evaluations",
  ].includes(name)));
});

test("migration refuses an incompatible existing table before creating a missing table", async () => {
  const incompatibleMonitorTable = monitorSessionsDefinition();
  incompatibleMonitorTable.columns[1] = column("ticket_id", "nvarchar", { maxLength: 128 });

  const db = createDatabase({
    tables: new Map([["bot_monitor_sessions", incompatibleMonitorTable]]),
  });

  await assert.rejects(
    initializeCoreSchema(db),
    (error) => error.code === "SQLSERVER_INCOMPATIBLE_SCHEMA"
      && error.message.includes("bot_monitor_sessions.ticket_id"),
  );
  assert.equal(db.batches.length, 0);
});

test("normal startup verification does not create missing tables", async () => {
  const db = createDatabase();

  await assert.rejects(
    verifyCoreSchema(db, "support"),
    (error) => error.code === "SQLSERVER_MISSING_TABLE",
  );
  assert.equal(db.batches.length, 0);
});

test("upgrading the two-table schema adds evaluation storage without changing existing tables", async () => {
  const state = conversationStateDefinition();
  const sessions = monitorSessionsDefinition();
  const tables = new Map([["bot_conversation_state", state], ["bot_monitor_sessions", sessions]]);
  const db = createDatabase({ tables });
  assert.equal(await initializeCoreSchema(db, "support"), true);
  assert.equal(tables.get("bot_conversation_state"), state);
  assert.equal(tables.get("bot_monitor_sessions"), sessions);
  assert.ok(tables.has("bot_monitor_evaluations"));
  assert.match(db.batches[0], /FOREIGN KEY \(\[session_id\]\)/);
  assert.doesNotMatch(db.batches[0], /\b(?:ALTER|DROP|DELETE)\b/i);
});

test("startup refuses an evaluation table with an untrusted foreign key", async () => {
  const evaluations = monitorEvaluationsDefinition();
  evaluations.foreignKeys[0].is_not_trusted = true;
  const db = createDatabase({ tables: new Map([
    ["bot_conversation_state", conversationStateDefinition()], ["bot_monitor_sessions", monitorSessionsDefinition()],
    ["bot_monitor_evaluations", evaluations],
  ]) });
  await assert.rejects(verifyCoreSchema(db, "support"), { code: "SQLSERVER_INCOMPATIBLE_SCHEMA" });
});

test("migration requires the configured schema to exist", async () => {
  const db = createDatabase({ schemaExists: false });

  await assert.rejects(
    initializeCoreSchema(db, "missing_schema"),
    (error) => error.code === "SQLSERVER_SCHEMA_NOT_FOUND",
  );
  assert.equal(db.batches.length, 0);
});

test("schema and table helpers allow only safe, application-owned names", () => {
  assert.equal(databaseSchema("customer_support"), "customer_support");
  assert.equal(sqlTable("bot_conversation_state", "customer_support"),
    "[customer_support].[bot_conversation_state]");

  assert.throws(
    () => databaseSchema("dbo]; DROP TABLE users; --"),
    (error) => error.code === "SQLSERVER_INVALID_SCHEMA",
  );
  assert.throws(
    () => sqlTable("users", "dbo"),
    (error) => error.code === "SQLSERVER_TABLE_NOT_ALLOWED",
  );
});

test("SQL Server config uses secure defaults and validates connection limits", () => {
  const baseEnvironment = {
    DB_HOST: "sql.example.test",
    DB_USER: "support_app",
    DB_PASSWORD: "secret",
    DB_NAME: "support",
  };
  const config = sqlServerConfig(baseEnvironment);

  assert.equal(config.port, 1433);
  assert.equal(config.options.encrypt, true);
  assert.equal(config.options.trustServerCertificate, false);
  assert.equal(config.pool.max, 10);

  assert.throws(
    () => sqlServerConfig({ ...baseEnvironment, DB_PORT: "65536" }),
    /DB_PORT must be an integer between 1 and 65535/,
  );
  assert.throws(
    () => sqlServerConfig({ ...baseEnvironment, DB_POOL_CONNECTION_LIMIT: "1" }),
    /DB_POOL_CONNECTION_LIMIT must be an integer greater than or equal to 2/,
  );
});

test("startup propagates database permission errors without running the migration", async () => {
  const permissionError = Object.assign(new Error("SELECT denied"), {
    code: "EREQUEST",
  });
  const db = createDatabase({ queryError: permissionError });

  await assert.rejects(
    initializeCoreSchema(db),
    (error) => error === permissionError,
  );
  assert.equal(db.batches.length, 0);
});
