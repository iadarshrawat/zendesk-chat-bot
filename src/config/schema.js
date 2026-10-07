import { readFile } from "node:fs/promises";

const schemaFiles = [
  new URL("../../migrations/001_core.sql", import.meta.url),
  new URL("../../migrations/002_monitor_evaluations.sql", import.meta.url),
];
const DEFAULT_SCHEMA = "dbo";
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const coreTables = Object.freeze({
  bot_conversation_state: {
    columns: {
      conversation_id: { type: "nvarchar", maxLength: 256, nullable: false },
      state_json: { type: "nvarchar", maxLength: -1, nullable: false },
      updated_at: { type: "datetime2", scale: 3, nullable: false },
    },
    primaryKey: ["conversation_id"],
    indexes: {
      idx_bot_state_updated: ["updated_at"],
    },
    jsonColumn: "state_json",
  },
  bot_monitor_sessions: {
    columns: {
      session_id: { type: "nvarchar", maxLength: 510, nullable: false },
      ticket_id: { type: "nvarchar", maxLength: 64, nullable: false },
      session_started_at: { type: "datetime2", scale: 3, nullable: false },
      last_customer_at: { type: "datetime2", scale: 3, nullable: false },
      record_external_id: { type: "nvarchar", maxLength: 510, nullable: false },
      evaluated_at: { type: "datetime2", scale: 3, nullable: false },
    },
    primaryKey: ["session_id"],
    indexes: {
      idx_bot_monitor_ticket: ["ticket_id"],
    },
  },
});

const monitoringEvaluations = {
  columns: {
    session_id: { type: "nvarchar", maxLength: 510, nullable: false },
    session_number: { type: "int", nullable: false },
    ticket_subject: { type: "nvarchar", maxLength: 2048, nullable: false },
    ticket_created_at: { type: "datetime2", scale: 3, nullable: true },
    ticket_requester_id: { type: "nvarchar", maxLength: 256, nullable: true },
    first_message_id: { type: "nvarchar", maxLength: 256, nullable: false },
    last_message_at: { type: "datetime2", scale: 3, nullable: false },
    message_count: { type: "int", nullable: false },
    evaluation_due_at: { type: "datetime2", scale: 3, nullable: false },
    report_date: { type: "date", nullable: false },
    csat_score: { type: "varchar", maxLength: 32, nullable: false },
    reason: { type: "nvarchar", maxLength: 8000, nullable: false },
    monitoring_status: { type: "varchar", maxLength: 16, nullable: false },
    confidence: { type: "varchar", maxLength: 8, nullable: true },
    human_required: { type: "bit", nullable: true },
    follow_up_required: { type: "bit", nullable: true },
    key_issue: { type: "nvarchar", maxLength: 2048, nullable: true },
    updated_at: { type: "datetime2", scale: 3, nullable: false },
  },
  primaryKey: ["session_id"],
  indexes: { idx_bot_monitor_report: ["report_date", "updated_at", "session_id"] },
  requiredChecks: [
    "CK_bot_monitor_evaluations_score", "CK_bot_monitor_evaluations_status",
    "CK_bot_monitor_evaluations_confidence", "CK_bot_monitor_evaluations_counts",
  ],
  foreignKey: { name: "FK_bot_monitor_evaluations_session", column: "session_id", table: "bot_monitor_sessions" },
};
const tableDefinitions = Object.freeze({ ...coreTables, bot_monitor_evaluations: monitoringEvaluations });
const coreTableNames = Object.freeze(Object.keys(tableDefinitions));

function schemaError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Return a validated SQL Server schema name, defaulting to dbo. */
export function databaseSchema(schemaName = process.env.DB_SCHEMA) {
  const value = schemaName?.trim() || DEFAULT_SCHEMA;

  if (!SQL_IDENTIFIER.test(value)) {
    throw schemaError(
      "SQLSERVER_INVALID_SCHEMA",
      "DB_SCHEMA must be a SQL identifier containing only letters, numbers, and underscores",
    );
  }

  return value;
}

/**
 * Build a qualified name for an application-owned SQL table.
 * Keeping this allow-list here prevents callers from accidentally touching other tables.
 */
export function sqlTable(tableName, schemaName = process.env.DB_SCHEMA) {
  if (!Object.hasOwn(tableDefinitions, tableName)) {
    throw schemaError(
      "SQLSERVER_TABLE_NOT_ALLOWED",
      `Table is outside the application schema boundary: ${tableName}`,
    );
  }

  return `[${databaseSchema(schemaName)}].[${tableName}]`;
}

async function query(db, sql, parameters = {}) {
  const request = db.request();

  for (const [name, value] of Object.entries(parameters)) {
    request.input(name, value);
  }

  return request.query(sql);
}

async function schemaExists(db, schemaName) {
  const result = await query(
    db,
    "SELECT SCHEMA_ID(@schemaName) AS schema_id;",
    { schemaName },
  );

  return result.recordset?.[0]?.schema_id != null;
}

async function tableExists(db, schemaName, tableName) {
  const result = await query(
    db,
    `SELECT tables.object_id
       FROM sys.tables AS tables
       INNER JOIN sys.schemas AS schemas
         ON schemas.schema_id = tables.schema_id
      WHERE schemas.name = @schemaName
        AND tables.name = @tableName;`,
    { schemaName, tableName },
  );

  return result.recordset?.length > 0;
}

async function readColumns(db, schemaName, tableName) {
  const result = await query(
    db,
    `SELECT columns.name AS column_name,
            types.name AS data_type,
            columns.max_length,
            columns.scale,
            columns.is_nullable,
            columns.is_identity,
            columns.is_computed
       FROM sys.columns AS columns
       INNER JOIN sys.types AS types
         ON types.user_type_id = columns.user_type_id
       INNER JOIN sys.tables AS tables
         ON tables.object_id = columns.object_id
       INNER JOIN sys.schemas AS schemas
         ON schemas.schema_id = tables.schema_id
      WHERE schemas.name = @schemaName
        AND tables.name = @tableName
      ORDER BY columns.column_id;`,
    { schemaName, tableName },
  );

  return result.recordset ?? [];
}

async function readIndexes(db, schemaName, tableName) {
  const result = await query(
    db,
    `SELECT indexes.name AS index_name,
            indexes.is_primary_key,
            indexes.is_unique,
            indexes.is_disabled,
            indexes.has_filter,
            index_columns.key_ordinal,
            index_columns.is_included_column,
            columns.name AS column_name
       FROM sys.indexes AS indexes
       INNER JOIN sys.index_columns AS index_columns
         ON index_columns.object_id = indexes.object_id
        AND index_columns.index_id = indexes.index_id
       INNER JOIN sys.columns AS columns
         ON columns.object_id = index_columns.object_id
        AND columns.column_id = index_columns.column_id
       INNER JOIN sys.tables AS tables
         ON tables.object_id = indexes.object_id
       INNER JOIN sys.schemas AS schemas
         ON schemas.schema_id = tables.schema_id
      WHERE schemas.name = @schemaName
        AND tables.name = @tableName
        AND indexes.is_hypothetical = 0
      ORDER BY indexes.index_id, index_columns.key_ordinal;`,
    { schemaName, tableName },
  );

  return result.recordset ?? [];
}

async function readChecks(db, schemaName, tableName) {
  const result = await query(
    db,
    `SELECT checks.name AS constraint_name,
            checks.definition,
            checks.is_disabled,
            checks.is_not_trusted
       FROM sys.check_constraints AS checks
       INNER JOIN sys.tables AS tables
         ON tables.object_id = checks.parent_object_id
       INNER JOIN sys.schemas AS schemas
         ON schemas.schema_id = tables.schema_id
      WHERE schemas.name = @schemaName
        AND tables.name = @tableName;`,
    { schemaName, tableName },
  );

  return result.recordset ?? [];
}

function booleanValue(value) {
  return value === true || value === 1;
}

function sameColumnList(actual, expected) {
  return actual.length === expected.length
    && actual.every((column, index) => column === expected[index]);
}

function indexColumns(indexRows, predicate) {
  return indexRows
    .filter((row) => predicate(row) && !booleanValue(row.is_included_column))
    .sort((left, right) => Number(left.key_ordinal) - Number(right.key_ordinal))
    .map((row) => row.column_name);
}

function describeColumnMismatch(tableName, columns, expectedColumns) {
  const expectedNames = Object.keys(expectedColumns);
  const actualNames = columns.map((column) => column.column_name);

  if (!sameColumnList(actualNames, expectedNames)) {
    return `${tableName} columns are ${actualNames.join(", ") || "missing"}; expected ${expectedNames.join(", ")}`;
  }

  for (const column of columns) {
    const expected = expectedColumns[column.column_name];
    const actualType = String(column.data_type).toLowerCase();

    if (actualType !== expected.type) {
      return `${tableName}.${column.column_name} has type ${actualType}; expected ${expected.type}`;
    }
    if (expected.maxLength != null && Number(column.max_length) !== expected.maxLength) {
      return `${tableName}.${column.column_name} has max_length ${column.max_length}; expected ${expected.maxLength}`;
    }
    if (expected.scale != null && Number(column.scale) !== expected.scale) {
      return `${tableName}.${column.column_name} has scale ${column.scale}; expected ${expected.scale}`;
    }
    if (booleanValue(column.is_nullable) !== expected.nullable) {
      return `${tableName}.${column.column_name} has unexpected nullability`;
    }
    if (booleanValue(column.is_identity) || booleanValue(column.is_computed)) {
      return `${tableName}.${column.column_name} must not be an identity or computed column`;
    }
  }

  return undefined;
}

function describeIndexMismatch(tableName, indexes, expected) {
  const primaryRows = indexes.filter((row) => booleanValue(row.is_primary_key));
  const primaryKey = indexColumns(primaryRows, () => true);
  if (
    !sameColumnList(primaryKey, expected.primaryKey)
    || primaryRows.some((row) => booleanValue(row.is_disabled) || booleanValue(row.has_filter))
  ) {
    return `${tableName} must have primary key (${expected.primaryKey.join(", ")})`;
  }

  for (const [indexName, expectedColumns] of Object.entries(expected.indexes)) {
    const matchingRows = indexes.filter((row) => row.index_name === indexName);
    const columns = indexColumns(matchingRows, () => true);
    if (
      !sameColumnList(columns, expectedColumns)
      || matchingRows.some((row) => (
        booleanValue(row.is_disabled) || booleanValue(row.has_filter)
      ))
    ) {
      return `${tableName}.${indexName} must index (${expectedColumns.join(", ")})`;
    }
  }

  return undefined;
}

function describeCheckMismatch(tableName, checks, jsonColumn) {
  if (!jsonColumn) return undefined;

  const expectedName = "CK_bot_conversation_state_state_json";
  const jsonCheck = checks.find((check) => check.constraint_name === expectedName);
  const definition = String(jsonCheck?.definition ?? "").replace(/\s/g, "");
  const expectedExpression = new RegExp(
    `^\\(*ISJSON\\(\\[?${jsonColumn}\\]?\\)=\\(?1\\)?\\)*$`,
    "i",
  );

  if (
    !jsonCheck
    || booleanValue(jsonCheck.is_disabled)
    || booleanValue(jsonCheck.is_not_trusted)
    || !expectedExpression.test(definition)
  ) {
    return `${tableName}.${jsonColumn} must have an enabled, trusted ISJSON check`;
  }

  return undefined;
}

async function verifyTableDefinition(db, schemaName, tableName, expected) {
  const [columns, indexes, checks] = await Promise.all([
    readColumns(db, schemaName, tableName),
    readIndexes(db, schemaName, tableName),
    readChecks(db, schemaName, tableName),
  ]);

  const mismatch = describeColumnMismatch(tableName, columns, expected.columns)
    ?? describeIndexMismatch(tableName, indexes, expected)
    ?? describeCheckMismatch(tableName, checks, expected.jsonColumn);

  const missingCheck = expected.requiredChecks?.find(name => !checks.some(check => (
    check.constraint_name === name
    && !booleanValue(check.is_disabled) && !booleanValue(check.is_not_trusted)
  )));

  if (mismatch || missingCheck) {
    throw schemaError(
      "SQLSERVER_INCOMPATIBLE_SCHEMA",
      `Existing table [${schemaName}].[${tableName}] is incompatible: ${mismatch || `missing trusted check ${missingCheck}`}`,
    );
  }
  if (expected.foreignKey) {
    const result = await query(db, `SELECT keys.name AS constraint_name, keys.is_disabled, keys.is_not_trusted,
        COL_NAME(keys.parent_object_id, mapping.parent_column_id) AS column_name,
        OBJECT_SCHEMA_NAME(keys.referenced_object_id) AS referenced_schema,
        OBJECT_NAME(keys.referenced_object_id) AS referenced_table,
        COL_NAME(keys.referenced_object_id, mapping.referenced_column_id) AS referenced_column
      FROM sys.foreign_keys AS keys
      INNER JOIN sys.foreign_key_columns AS mapping ON mapping.constraint_object_id = keys.object_id
      INNER JOIN sys.tables AS tables ON tables.object_id = keys.parent_object_id
      INNER JOIN sys.schemas AS schemas ON schemas.schema_id = tables.schema_id
      WHERE schemas.name = @schemaName AND tables.name = @tableName`, { schemaName, tableName });
    const rows = result.recordset.filter(row => row.constraint_name === expected.foreignKey.name);
    const row = rows[0];
    if (rows.length !== 1 || booleanValue(row.is_disabled) || booleanValue(row.is_not_trusted)
      || row.column_name !== expected.foreignKey.column || row.referenced_schema !== schemaName
      || row.referenced_table !== expected.foreignKey.table || row.referenced_column !== "session_id") {
      throw schemaError("SQLSERVER_INCOMPATIBLE_SCHEMA", `${tableName} requires a trusted session foreign key`);
    }
  }
}

/** Verify that the application tables exist and match the expected contract. */
export async function verifyCoreSchema(db, requestedSchema) {
  const schemaName = databaseSchema(requestedSchema);

  if (!await schemaExists(db, schemaName)) {
    throw schemaError(
      "SQLSERVER_SCHEMA_NOT_FOUND",
      `SQL Server schema [${schemaName}] does not exist; create it before starting the application`,
    );
  }

  const missingTables = [];

  for (const tableName of coreTableNames) {
    if (!await tableExists(db, schemaName, tableName)) {
      missingTables.push(tableName);
      continue;
    }

    await verifyTableDefinition(db, schemaName, tableName, tableDefinitions[tableName]);
  }

  if (missingTables.length > 0) {
    throw schemaError(
      "SQLSERVER_MISSING_TABLE",
      `Missing SQL Server table(s): ${missingTables.map((name) => sqlTable(name, schemaName)).join(", ")}`,
    );
  }
}

function renderMigration(template, schemaName) {
  const sql = template.replaceAll("{{schema}}", schemaName);
  const createdTables = [...sql.matchAll(/\bCREATE\s+TABLE\s+\[[^\]]+]\.\[([^\]]+)]/gi)]
    .map((match) => match[1]);
  const tableCreateCount = [...sql.matchAll(/\bCREATE\s+TABLE\b/gi)].length;
  const createdIndexTargets = [...sql.matchAll(
    /\bCREATE\s+INDEX\s+\[[^\]]+]\s+ON\s+\[[^\]]+]\.\[([^\]]+)]/gi,
  )].map((match) => match[1]);
  const indexCreateCount = [...sql.matchAll(/\bCREATE\s+INDEX\b/gi)].length;
  const qualifiedObjects = [...sql.matchAll(/\[([^\]]+)]\.\[([^\]]+)]/g)]
    .map((match) => ({ schema: match[1], name: match[2] }));
  const createKinds = [...sql.matchAll(/\bCREATE\s+([A-Z_]+)/gi)]
    .map((match) => match[1].toUpperCase());

  const createsOnlyCoreTables = tableCreateCount === coreTableNames.length
    && createdTables.length === tableCreateCount
    && coreTableNames.every((tableName) => createdTables.includes(tableName));
  const indexesOnlyCoreTables = indexCreateCount === coreTableNames.length
    && createdIndexTargets.length === indexCreateCount
    && coreTableNames.every((tableName) => createdIndexTargets.includes(tableName));
  const referencesOnlyCoreTables = qualifiedObjects.every(({ schema, name }) => (
    schema === schemaName && coreTableNames.includes(name)
  ));
  const createsOnlyTablesAndIndexes = createKinds.every((kind) => (
    kind === "TABLE" || kind === "INDEX"
  ));

  if (
    !createsOnlyCoreTables
    || !indexesOnlyCoreTables
    || !referencesOnlyCoreTables
    || !createsOnlyTablesAndIndexes
    || /\bbot_(?:inbox|forms)\b/i.test(sql)
  ) {
    throw schemaError(
      "SQLSERVER_UNSAFE_MIGRATION",
      "Migration must create only the approved conversation-state and monitoring tables",
    );
  }
  if (/\b(?:DROP|ALTER|INSERT|UPDATE|DELETE|MERGE|TRUNCATE|SELECT|EXEC(?:UTE)?|GRANT|DENY|REVOKE)\b/i.test(sql)) {
    throw schemaError(
      "SQLSERVER_UNSAFE_MIGRATION",
      "Core migration must not modify existing database objects or data",
    );
  }

  return sql;
}

/** Create only missing core tables; existing tables are never changed. */
export async function applyCoreSchema(db, requestedSchema) {
  const schemaName = databaseSchema(requestedSchema);
  const template = (await Promise.all(schemaFiles.map(file => readFile(file, "utf8")))).join("\n");
  const sql = renderMigration(template, schemaName);

  await db.request().batch(sql);
}

/** Create the core tables only when one is absent; never modify existing tables. */
export async function initializeCoreSchema(db, requestedSchema) {
  try {
    await verifyCoreSchema(db, requestedSchema);
    return false;
  } catch (error) {
    if (error?.code !== "SQLSERVER_MISSING_TABLE") throw error;
  }

  await applyCoreSchema(db, requestedSchema);
  await verifyCoreSchema(db, requestedSchema);
  return true;
}
