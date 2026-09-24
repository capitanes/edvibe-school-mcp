export const LATEST_TELEMETRY_SCHEMA_VERSION = 2;

const MIGRATIONS = Object.freeze([
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS telemetry_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS telemetry_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS telemetry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        occurred_at_ms INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        request_id TEXT,
        transport TEXT,
        tenant_id TEXT,
        installation_id TEXT,
        client_family TEXT,
        client_version TEXT,
        mcp_method TEXT,
        tool_name TEXT,
        tool_group TEXT,
        tool_risk TEXT,
        outcome TEXT,
        error_code TEXT,
        upstream_status INTEGER,
        duration_ms REAL,
        upstream_duration_ms REAL,
        limiter_wait_ms REAL
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS telemetry_events_time_idx
        ON telemetry_events(occurred_at_ms DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS telemetry_events_active_tenant_idx
        ON telemetry_events(event_type, outcome, occurred_at_ms, tenant_id)`,
      `CREATE INDEX IF NOT EXISTS telemetry_events_installation_idx
        ON telemetry_events(installation_id, occurred_at_ms)`,
      `CREATE INDEX IF NOT EXISTS telemetry_events_tool_idx
        ON telemetry_events(tool_name, occurred_at_ms)`,
      `CREATE INDEX IF NOT EXISTS telemetry_events_error_idx
        ON telemetry_events(error_code, occurred_at_ms)`,
      `CREATE TABLE IF NOT EXISTS telemetry_installations (
        installation_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        client_family TEXT,
        client_version TEXT,
        initialize_count INTEGER NOT NULL DEFAULT 0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        successful_tool_call_count INTEGER NOT NULL DEFAULT 0,
        last_tool_at TEXT
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS telemetry_installations_tenant_idx
        ON telemetry_installations(tenant_id, last_seen_at DESC)`,
      aggregateTableSql("telemetry_hourly", "hour_utc"),
      aggregateTableSql("telemetry_daily", "day_utc"),
      `CREATE INDEX IF NOT EXISTS telemetry_hourly_time_idx
        ON telemetry_hourly(hour_utc DESC)`,
      `CREATE INDEX IF NOT EXISTS telemetry_daily_time_idx
        ON telemetry_daily(day_utc DESC)`,
    ],
  },
  {
    version: 2,
    statements: [
      // Aggregate rows must not retain tenant/installation pseudonyms beyond
      // detail-event retention. Rebuild to safely merge old identity-keyed rows.
      aggregateTableSql("telemetry_hourly_v2", "hour_utc"),
      aggregatePrivacyCopySql("telemetry_hourly", "telemetry_hourly_v2", "hour_utc"),
      "DROP TABLE telemetry_hourly",
      "ALTER TABLE telemetry_hourly_v2 RENAME TO telemetry_hourly",
      `CREATE INDEX telemetry_hourly_time_idx ON telemetry_hourly(hour_utc DESC)`,
      aggregateTableSql("telemetry_daily_v2", "day_utc"),
      aggregatePrivacyCopySql("telemetry_daily", "telemetry_daily_v2", "day_utc"),
      "DROP TABLE telemetry_daily",
      "ALTER TABLE telemetry_daily_v2 RENAME TO telemetry_daily",
      `CREATE INDEX telemetry_daily_time_idx ON telemetry_daily(day_utc DESC)`,
      `CREATE TABLE IF NOT EXISTS telemetry_daily_summary (
        day_utc TEXT PRIMARY KEY,
        initializations INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        successful_tool_calls INTEGER NOT NULL DEFAULT 0,
        failed_tool_calls INTEGER NOT NULL DEFAULT 0,
        identified_tool_calls INTEGER NOT NULL DEFAULT 0,
        active_tenants INTEGER NOT NULL DEFAULT 0,
        active_installations INTEGER NOT NULL DEFAULT 0,
        duration_sum REAL NOT NULL DEFAULT 0,
        duration_count INTEGER NOT NULL DEFAULT 0,
        upstream_duration_sum REAL NOT NULL DEFAULT 0,
        upstream_duration_count INTEGER NOT NULL DEFAULT 0,
        limiter_wait_sum REAL NOT NULL DEFAULT 0,
        limiter_wait_count INTEGER NOT NULL DEFAULT 0
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS telemetry_daily_summary_time_idx
        ON telemetry_daily_summary(day_utc DESC)`,
    ],
  },
]);

/** Apply pending migrations in a transaction and reject newer unknown schemas. */
export function applyTelemetryMigrations(database, { now = () => new Date() } = {}) {
  database.exec(`CREATE TABLE IF NOT EXISTS telemetry_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT`);

  const existing = new Set(
    database.prepare("SELECT version FROM telemetry_schema_migrations ORDER BY version").all().map((row) => row.version),
  );
  const maximum = existing.size > 0 ? Math.max(...existing) : 0;
  if (maximum > LATEST_TELEMETRY_SCHEMA_VERSION) {
    throw new Error("Telemetry database schema is newer than this service.");
  }

  const apply = database.transaction((migration) => {
    for (const statement of migration.statements) database.exec(statement);
    database.prepare(
      "INSERT INTO telemetry_schema_migrations(version, applied_at) VALUES (?, ?)",
    ).run(migration.version, now().toISOString());
  });

  for (const migration of MIGRATIONS) {
    if (!existing.has(migration.version)) apply(migration);
  }
  return LATEST_TELEMETRY_SCHEMA_VERSION;
}

function aggregateTableSql(table, bucket) {
  return `CREATE TABLE IF NOT EXISTS ${table} (
    ${bucket} TEXT NOT NULL,
    event_type TEXT NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT '',
    installation_id TEXT NOT NULL DEFAULT '',
    client_family TEXT NOT NULL DEFAULT '',
    client_version TEXT NOT NULL DEFAULT '',
    mcp_method TEXT NOT NULL DEFAULT '',
    tool_name TEXT NOT NULL DEFAULT '',
    tool_group TEXT NOT NULL DEFAULT '',
    tool_risk TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL DEFAULT '',
    error_code TEXT NOT NULL DEFAULT '',
    upstream_status INTEGER NOT NULL DEFAULT 0,
    event_count INTEGER NOT NULL,
    duration_sum REAL NOT NULL DEFAULT 0,
    duration_count INTEGER NOT NULL DEFAULT 0,
    upstream_duration_sum REAL NOT NULL DEFAULT 0,
    upstream_duration_count INTEGER NOT NULL DEFAULT 0,
    limiter_wait_sum REAL NOT NULL DEFAULT 0,
    limiter_wait_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (
      ${bucket}, event_type, tenant_id, installation_id, client_family,
      client_version, mcp_method, tool_name, tool_group, tool_risk,
      outcome, error_code, upstream_status
    )
  ) WITHOUT ROWID, STRICT`;
}

function aggregatePrivacyCopySql(source, target, bucket) {
  return `INSERT INTO ${target} (
    ${bucket}, event_type, tenant_id, installation_id, client_family,
    client_version, mcp_method, tool_name, tool_group, tool_risk, outcome,
    error_code, upstream_status, event_count, duration_sum, duration_count,
    upstream_duration_sum, upstream_duration_count, limiter_wait_sum,
    limiter_wait_count
  )
  SELECT
    ${bucket}, event_type, '', '', client_family, client_version, mcp_method,
    tool_name, tool_group, tool_risk, outcome, error_code, upstream_status,
    SUM(event_count), SUM(duration_sum), SUM(duration_count),
    SUM(upstream_duration_sum), SUM(upstream_duration_count),
    SUM(limiter_wait_sum), SUM(limiter_wait_count)
  FROM ${source}
  GROUP BY ${bucket}, event_type, client_family, client_version, mcp_method,
    tool_name, tool_group, tool_risk, outcome, error_code, upstream_status`;
}
