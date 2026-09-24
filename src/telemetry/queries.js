import { isClientFamily } from "./client-info.js";
import { EVENT_OUTCOMES, EVENT_TYPES } from "./schema.js";
import { isTelemetryPseudonym } from "./identity.js";

const PERIODS_MS = Object.freeze({
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
  "365d": 365 * 86_400_000,
});
const MAX_QUERY_MS = 90 * 86_400_000;
const MAX_AGGREGATE_QUERY_MS = 365 * 86_400_000;
const MAX_SCENARIO_ROWS = 100_000;

/** Query product metrics from detail events (retained for 90 days). */
export function queryDashboard(database, query = {}, { now = () => new Date() } = {}) {
  const normalized = normalizeFilters(query, {
    now,
    defaultPeriod: "7d",
    maxRangeMs: MAX_AGGREGATE_QUERY_MS,
  });
  const rangeMs = new Date(normalized.to).getTime() - new Date(normalized.from).getTime();
  if (rangeMs > MAX_QUERY_MS) return queryAggregateDashboard(database, normalized);
  const filtered = buildWhere(normalized);
  const toolWhere = `${filtered.sql} AND event_type = 'tool_call_completed'`;

  const totals = database.prepare(`
    SELECT
      SUM(CASE WHEN event_type = 'mcp_initialize_completed' THEN 1 ELSE 0 END) AS initializations,
      SUM(CASE WHEN event_type = 'tool_call_completed' THEN 1 ELSE 0 END) AS tool_calls,
      SUM(CASE WHEN event_type = 'tool_call_completed' AND outcome = 'success' THEN 1 ELSE 0 END) AS successful_tool_calls,
      SUM(CASE WHEN event_type = 'tool_call_completed' AND outcome != 'success' THEN 1 ELSE 0 END) AS failed_tool_calls,
      SUM(CASE WHEN event_type = 'tool_call_completed' AND installation_id IS NOT NULL THEN 1 ELSE 0 END) AS identified_tool_calls,
      COUNT(DISTINCT CASE WHEN event_type = 'tool_call_completed' AND outcome = 'success' THEN tenant_id END) AS active_tenants,
      COUNT(DISTINCT CASE WHEN event_type = 'tool_call_completed' AND outcome = 'success' THEN installation_id END) AS active_installations,
      AVG(CASE WHEN event_type = 'tool_call_completed' THEN duration_ms END) AS average_duration_ms,
      AVG(CASE WHEN event_type = 'tool_call_completed' THEN upstream_duration_ms END) AS average_upstream_duration_ms,
      AVG(CASE WHEN event_type = 'tool_call_completed' THEN limiter_wait_ms END) AS average_limiter_wait_ms
    FROM telemetry_events
    ${filtered.sql}
  `).get(filtered.params);

  const toolCalls = number(totals.tool_calls);
  const successfulCalls = number(totals.successful_tool_calls);
  const identifiedCalls = number(totals.identified_tool_calls);
  const durationCount = database.prepare(
    `SELECT COUNT(*) AS count FROM telemetry_events ${toolWhere} AND duration_ms IS NOT NULL`,
  ).get(filtered.params).count;
  const p95DurationMs = durationCount > 0
    ? database.prepare(
        `SELECT duration_ms FROM telemetry_events ${toolWhere} AND duration_ms IS NOT NULL
         ORDER BY duration_ms ASC LIMIT 1 OFFSET @percentileOffset`,
      ).get({ ...filtered.params, percentileOffset: Math.max(0, Math.ceil(durationCount * 0.95) - 1) })?.duration_ms ?? null
    : null;
  const p50DurationMs = durationCount > 0
    ? database.prepare(
        `SELECT duration_ms FROM telemetry_events ${toolWhere} AND duration_ms IS NOT NULL
         ORDER BY duration_ms ASC LIMIT 1 OFFSET @percentileOffset`,
      ).get({ ...filtered.params, percentileOffset: Math.max(0, Math.ceil(durationCount * 0.5) - 1) })?.duration_ms ?? null
    : null;

  const windows = queryActivityWindows(database, normalized);

  const tools = database.prepare(`
    SELECT
      tool_name AS toolName,
      tool_group AS toolGroup,
      tool_risk AS toolRisk,
      COUNT(*) AS calls,
      SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) AS failures,
      AVG(duration_ms) AS averageDurationMs,
      AVG(upstream_duration_ms) AS averageUpstreamDurationMs,
      AVG(limiter_wait_ms) AS averageLimiterWaitMs
    FROM telemetry_events
    ${toolWhere}
    GROUP BY tool_name, tool_group, tool_risk
    ORDER BY calls DESC, tool_name ASC
    LIMIT 100
  `).all(filtered.params).map(normalizeNumericRow);

  const groups = database.prepare(`
    SELECT tool_group AS toolGroup, COUNT(*) AS calls,
      SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successes
    FROM telemetry_events
    ${toolWhere}
    GROUP BY tool_group
    ORDER BY calls DESC, tool_group ASC
  `).all(filtered.params).map(normalizeNumericRow);

  const errors = database.prepare(`
    SELECT error_code AS errorCode, COUNT(*) AS count
    FROM telemetry_events
    ${filtered.sql} AND error_code IS NOT NULL
    GROUP BY error_code
    ORDER BY count DESC, error_code ASC
  `).all(filtered.params).map(normalizeNumericRow);

  const moscowHours = database.prepare(`
    SELECT CAST(strftime('%H', occurred_at, '+3 hours') AS INTEGER) AS hour, COUNT(*) AS calls
    FROM telemetry_events
    ${toolWhere}
    GROUP BY hour
    ORDER BY hour ASC
  `).all(filtered.params).map(normalizeNumericRow);

  const daily = database.prepare(`
    SELECT substr(occurred_at, 1, 10) AS dayUtc,
      COUNT(*) AS calls,
      SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successes,
      COUNT(DISTINCT CASE WHEN outcome = 'success' THEN tenant_id END) AS activeTenants,
      COUNT(DISTINCT CASE WHEN outcome = 'success' THEN installation_id END) AS activeInstallations
    FROM telemetry_events
    ${toolWhere}
    GROUP BY dayUtc
    ORDER BY dayUtc ASC
  `).all(filtered.params).map(normalizeNumericRow);

  const activity = queryDetailActivity(database, normalized, filtered);
  const heatmap = queryDetailHeatmap(database, filtered);

  const clients = database.prepare(`
    SELECT
      COALESCE(client_family, 'unknown') AS clientFamily,
      client_version AS clientVersion,
      COUNT(DISTINCT installation_id) AS installations,
      COUNT(*) AS calls,
      SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successes,
      CAST(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS successRate,
      MAX(occurred_at) AS lastSeen
    FROM telemetry_events
    ${toolWhere} AND installation_id IS NOT NULL
    GROUP BY COALESCE(client_family, 'unknown'), client_version
    ORDER BY calls DESC, clientFamily ASC, clientVersion ASC
    LIMIT 100
  `).all(filtered.params).map(normalizeNumericRow);

  const scenarios = queryScenarios(database, normalized, { normalized: true });

  return Object.freeze({
    range: Object.freeze({
      from: normalized.from,
      to: normalized.to,
      timezone: "Europe/Moscow",
      aggregation: "detail",
    }),
    totals: Object.freeze({
      initializations: number(totals.initializations),
      toolCalls,
      successfulToolCalls: successfulCalls,
      failedToolCalls: number(totals.failed_tool_calls),
      activeTenants: number(totals.active_tenants),
      activeInstallations: number(totals.active_installations),
      identifiedToolCalls: identifiedCalls,
      identifiedShare: toolCalls === 0 ? 0 : identifiedCalls / toolCalls,
      successRate: toolCalls === 0 ? 0 : successfulCalls / toolCalls,
      averageDurationMs: nullableNumber(totals.average_duration_ms),
      p50DurationMs: nullableNumber(p50DurationMs),
      p95DurationMs: nullableNumber(p95DurationMs),
      averageUpstreamDurationMs: nullableNumber(totals.average_upstream_duration_ms),
      averageLimiterWaitMs: nullableNumber(totals.average_limiter_wait_ms),
    }),
    activityWindows: Object.freeze(windows),
    activity: Object.freeze(activity),
    heatmap: Object.freeze(heatmap),
    daily: Object.freeze(daily),
    moscowHours: Object.freeze(moscowHours),
    tools: Object.freeze(tools),
    groups: Object.freeze(groups),
    errors: Object.freeze(errors),
    clients: Object.freeze(clients),
    scenarios,
  });
}

function queryAggregateDashboard(database, normalized) {
  const filtered = buildAggregateWhere(normalized, "day");
  const toolWhere = `${filtered.sql} AND event_type = 'tool_call_completed'`;
  const totals = database.prepare(`
    SELECT
      SUM(CASE WHEN event_type = 'mcp_initialize_completed' THEN event_count ELSE 0 END) AS initializations,
      SUM(CASE WHEN event_type = 'tool_call_completed' THEN event_count ELSE 0 END) AS tool_calls,
      SUM(CASE WHEN event_type = 'tool_call_completed' AND outcome = 'success' THEN event_count ELSE 0 END) AS successful_tool_calls,
      SUM(CASE WHEN event_type = 'tool_call_completed' AND outcome != 'success' THEN event_count ELSE 0 END) AS failed_tool_calls,
      SUM(CASE WHEN event_type = 'tool_call_completed' THEN duration_sum ELSE 0 END) AS duration_sum,
      SUM(CASE WHEN event_type = 'tool_call_completed' THEN duration_count ELSE 0 END) AS duration_count,
      SUM(CASE WHEN event_type = 'tool_call_completed' THEN upstream_duration_sum ELSE 0 END) AS upstream_duration_sum,
      SUM(CASE WHEN event_type = 'tool_call_completed' THEN upstream_duration_count ELSE 0 END) AS upstream_duration_count,
      SUM(CASE WHEN event_type = 'tool_call_completed' THEN limiter_wait_sum ELSE 0 END) AS limiter_wait_sum,
      SUM(CASE WHEN event_type = 'tool_call_completed' THEN limiter_wait_count ELSE 0 END) AS limiter_wait_count
    FROM telemetry_daily
    ${filtered.sql}
  `).get(filtered.params);

  const tools = database.prepare(`
    SELECT
      tool_name AS toolName,
      tool_group AS toolGroup,
      tool_risk AS toolRisk,
      SUM(event_count) AS calls,
      SUM(CASE WHEN outcome = 'success' THEN event_count ELSE 0 END) AS successes,
      SUM(CASE WHEN outcome != 'success' THEN event_count ELSE 0 END) AS failures,
      CASE WHEN SUM(duration_count) = 0 THEN NULL ELSE SUM(duration_sum) / SUM(duration_count) END AS averageDurationMs,
      CASE WHEN SUM(upstream_duration_count) = 0 THEN NULL ELSE SUM(upstream_duration_sum) / SUM(upstream_duration_count) END AS averageUpstreamDurationMs,
      CASE WHEN SUM(limiter_wait_count) = 0 THEN NULL ELSE SUM(limiter_wait_sum) / SUM(limiter_wait_count) END AS averageLimiterWaitMs
    FROM telemetry_daily
    ${toolWhere}
    GROUP BY tool_name, tool_group, tool_risk
    ORDER BY calls DESC, tool_name ASC
    LIMIT 100
  `).all(filtered.params).map(normalizeNumericRow);

  const groups = database.prepare(`
    SELECT tool_group AS toolGroup, SUM(event_count) AS calls,
      SUM(CASE WHEN outcome = 'success' THEN event_count ELSE 0 END) AS successes
    FROM telemetry_daily
    ${toolWhere}
    GROUP BY tool_group
    ORDER BY calls DESC, tool_group ASC
  `).all(filtered.params).map(normalizeNumericRow);

  const clients = database.prepare(`
    SELECT
      CASE WHEN client_family = '' THEN 'unknown' ELSE client_family END AS clientFamily,
      NULLIF(client_version, '') AS clientVersion,
      NULL AS installations,
      SUM(event_count) AS calls,
      SUM(CASE WHEN outcome = 'success' THEN event_count ELSE 0 END) AS successes,
      CASE WHEN SUM(event_count) = 0 THEN 0 ELSE
        CAST(SUM(CASE WHEN outcome = 'success' THEN event_count ELSE 0 END) AS REAL) / SUM(event_count)
      END AS successRate,
      MAX(day_utc) AS lastSeen
    FROM telemetry_daily
    ${toolWhere}
    GROUP BY client_family, client_version
    ORDER BY calls DESC, clientFamily ASC, clientVersion ASC
    LIMIT 100
  `).all(filtered.params).map(normalizeNumericRow);

  const errors = database.prepare(`
    SELECT error_code AS errorCode, SUM(event_count) AS count
    FROM telemetry_daily
    ${filtered.sql} AND error_code != ''
    GROUP BY error_code
    ORDER BY count DESC, error_code ASC
  `).all(filtered.params).map(normalizeNumericRow);

  const hourlyWhere = buildAggregateWhere(normalized, "hour");
  const moscowHours = database.prepare(`
    SELECT CAST(strftime('%H', hour_utc, '+3 hours') AS INTEGER) AS hour,
      SUM(event_count) AS calls
    FROM telemetry_hourly
    ${hourlyWhere.sql} AND event_type = 'tool_call_completed'
    GROUP BY hour
    ORDER BY hour ASC
  `).all(hourlyWhere.params).map(normalizeNumericRow);
  const heatmap = database.prepare(`
    SELECT
      ((CAST(strftime('%w', hour_utc, '+3 hours') AS INTEGER) + 6) % 7) AS weekday,
      CAST(strftime('%H', hour_utc, '+3 hours') AS INTEGER) AS hour,
      SUM(event_count) AS calls
    FROM telemetry_hourly
    ${hourlyWhere.sql} AND event_type = 'tool_call_completed'
    GROUP BY weekday, hour
    ORDER BY weekday ASC, hour ASC
  `).all(hourlyWhere.params).map(normalizeNumericRow);

  const dailyAggregates = database.prepare(`
    SELECT day_utc AS dayUtc,
      SUM(CASE WHEN event_type = 'tool_call_completed' THEN event_count ELSE 0 END) AS calls,
      SUM(CASE WHEN event_type = 'tool_call_completed' AND outcome = 'success' THEN event_count ELSE 0 END) AS successes
    FROM telemetry_daily
    ${filtered.sql}
    GROUP BY day_utc
    ORDER BY day_utc ASC
  `).all(filtered.params).map(normalizeNumericRow);

  const hasDimensionFilters = [
    "clientFamily", "toolGroup", "toolName", "outcome", "eventType",
  ].some((key) => normalized[key] !== undefined);
  const dailySummary = hasDimensionFilters
    ? new Map()
    : loadAnonymousDailySummary(database, normalized);
  const daily = dailyAggregates.map((row) => {
    const summary = dailySummary.get(row.dayUtc);
    return Object.freeze({
      ...row,
      activeTenants: summary?.activeTenants ?? null,
      activeInstallations: summary?.activeInstallations ?? null,
      identifiedToolCalls: summary?.identifiedToolCalls ?? null,
    });
  });
  const availableSummary = daily.map((row) => row.activeTenants === null ? null : row).filter(Boolean);
  const activeTenantDays = availableSummary.reduce((sum, row) => sum + row.activeTenants, 0);
  const activeInstallationDays = availableSummary.reduce((sum, row) => sum + row.activeInstallations, 0);
  const identifiedToolCalls = hasDimensionFilters
    ? null
    : availableSummary.reduce((sum, row) => sum + row.identifiedToolCalls, 0);
  const toolCalls = number(totals.tool_calls);
  const successfulCalls = number(totals.successful_tool_calls);
  const durationCount = number(totals.duration_count);
  const upstreamDurationCount = number(totals.upstream_duration_count);
  const limiterWaitCount = number(totals.limiter_wait_count);
  const aggregateActivity = database.prepare(`
    SELECT strftime('%Y-%m-%dT00:00:00+03:00', hour_utc, '+3 hours') AS bucket,
      SUM(event_count) AS calls,
      SUM(CASE WHEN outcome = 'success' THEN event_count ELSE 0 END) AS successes
    FROM telemetry_hourly
    ${hourlyWhere.sql} AND event_type = 'tool_call_completed'
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(hourlyWhere.params).map(normalizeNumericRow);

  return Object.freeze({
    range: Object.freeze({
      from: normalized.from,
      to: normalized.to,
      timezone: "Europe/Moscow",
      aggregation: "anonymous_daily",
    }),
    totals: Object.freeze({
      initializations: number(totals.initializations),
      toolCalls,
      successfulToolCalls: successfulCalls,
      failedToolCalls: number(totals.failed_tool_calls),
      activeTenants: null,
      activeInstallations: null,
      activeTenantDays,
      activeInstallationDays,
      peakDailyActiveTenants: availableSummary.length
        ? Math.max(...availableSummary.map((row) => row.activeTenants))
        : null,
      peakDailyActiveInstallations: availableSummary.length
        ? Math.max(...availableSummary.map((row) => row.activeInstallations))
        : null,
      identifiedToolCalls,
      identifiedShare: identifiedToolCalls === null || toolCalls === 0 ? null : identifiedToolCalls / toolCalls,
      successRate: toolCalls === 0 ? 0 : successfulCalls / toolCalls,
      averageDurationMs: durationCount === 0 ? null : number(totals.duration_sum) / durationCount,
      p50DurationMs: null,
      p95DurationMs: null,
      averageUpstreamDurationMs: upstreamDurationCount === 0
        ? null
        : number(totals.upstream_duration_sum) / upstreamDurationCount,
      averageLimiterWaitMs: limiterWaitCount === 0
        ? null
        : number(totals.limiter_wait_sum) / limiterWaitCount,
    }),
    activityWindows: Object.freeze(queryActivityWindows(database, normalized)),
    activity: Object.freeze(aggregateActivity),
    heatmap: Object.freeze(heatmap),
    daily: Object.freeze(daily),
    moscowHours: Object.freeze(moscowHours),
    tools: Object.freeze(tools),
    groups: Object.freeze(groups),
    errors: Object.freeze(errors),
    clients: Object.freeze(clients),
    scenarios: Object.freeze({
      sessionIdleMinutes: 30,
      sourceRows: 0,
      truncated: false,
      unavailableReason: "detail_retention_exceeded",
      items: Object.freeze([]),
    }),
  });
}

/** Return a safe, paginated list of allow-listed event columns. */
export function queryEvents(database, query = {}, { now = () => new Date() } = {}) {
  // The event list may be requested with the annual dashboard range, but it
  // can only return rows that still exist inside the 90-day detail retention
  // window. Identity filters remain safe here because aggregate tables are
  // never consulted by this query.
  const normalized = normalizeFilters(query, {
    now,
    defaultPeriod: "24h",
    maxRangeMs: MAX_AGGREGATE_QUERY_MS,
    allowIdentityBeyondDetail: true,
  });
  const page = boundedInteger(query.page, 1, 1, 10_000);
  const pageSize = boundedInteger(query.pageSize, 50, 1, 100);
  const offset = (page - 1) * pageSize;
  const filtered = buildWhere(normalized);

  const total = database.prepare(
    `SELECT COUNT(*) AS count FROM telemetry_events ${filtered.sql}`,
  ).get(filtered.params).count;
  const rows = database.prepare(`
    SELECT occurred_at, event_type, request_id, transport, tenant_id, installation_id,
      client_family, client_version, mcp_method, tool_name, tool_group,
      tool_risk, outcome, error_code, upstream_status, duration_ms, upstream_duration_ms,
      limiter_wait_ms
    FROM telemetry_events
    ${filtered.sql}
    ORDER BY occurred_at_ms DESC, id DESC
    LIMIT @pageSize OFFSET @offset
  `).all({ ...filtered.params, pageSize, offset }).map(rowToEvent);

  return Object.freeze({
    range: Object.freeze({ from: normalized.from, to: normalized.to }),
    page,
    pageSize,
    total: number(total),
    pages: Math.ceil(number(total) / pageSize),
    items: Object.freeze(rows),
  });
}

/**
 * Estimate common adjacent 2–5 tool chains within 30-minute installation
 * sessions. Only successful calls with a valid installation pseudonym qualify.
 */
export function queryScenarios(database, query = {}, options = {}) {
  const normalized = options.normalized
    ? query
    : normalizeFilters(query, { now: options.now ?? (() => new Date()), defaultPeriod: "7d" });
  const filtered = buildWhere(normalized);
  const rows = database.prepare(`
    SELECT tenant_id, installation_id, occurred_at_ms, tool_name
    FROM telemetry_events
    ${filtered.sql}
      AND event_type = 'tool_call_completed'
      AND outcome = 'success'
      AND installation_id IS NOT NULL
    ORDER BY tenant_id, installation_id, occurred_at_ms, id
    LIMIT ${MAX_SCENARIO_ROWS + 1}
  `).all(filtered.params);

  const truncated = rows.length > MAX_SCENARIO_ROWS;
  if (truncated) rows.length = MAX_SCENARIO_ROWS;
  const counts = new Map();
  let currentKey = null;
  let previousAt = null;
  let session = [];

  const finish = () => {
    for (let start = 0; start < session.length; start += 1) {
      for (let length = 2; length <= 5 && start + length <= session.length; length += 1) {
        const tools = session.slice(start, start + length);
        const key = tools.join("\u001f");
        const aggregate = counts.get(key) ?? { tools, count: 0 };
        aggregate.count += 1;
        counts.set(key, aggregate);
      }
    }
    session = [];
  };

  for (const row of rows) {
    const key = `${row.tenant_id}\u0000${row.installation_id}`;
    if (key !== currentKey || (previousAt !== null && row.occurred_at_ms - previousAt > 30 * 60_000)) {
      finish();
      currentKey = key;
    }
    session.push(row.tool_name);
    previousAt = row.occurred_at_ms;
  }
  finish();

  const limit = boundedInteger(query.limit, 20, 1, 100);
  const items = [...counts.values()]
    .sort((left, right) => right.count - left.count || left.tools.join("\u001f").localeCompare(right.tools.join("\u001f")))
    .slice(0, limit)
    .map((item) => Object.freeze({ tools: Object.freeze(item.tools), count: item.count }));

  return Object.freeze({
    sessionIdleMinutes: 30,
    sourceRows: rows.length,
    truncated,
    items: Object.freeze(items),
  });
}

export function normalizeTelemetryQuery(query = {}, { now = () => new Date(), defaultPeriod = "7d" } = {}) {
  return normalizeFilters(query, { now, defaultPeriod });
}

function normalizeFilters(query, {
  now,
  defaultPeriod,
  maxRangeMs = MAX_QUERY_MS,
  allowIdentityBeyondDetail = false,
}) {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new TypeError("Invalid telemetry query.");
  const to = parseDate(query.to, now().toISOString());
  const period = query.period ?? defaultPeriod;
  if (!Object.hasOwn(PERIODS_MS, period)) throw new TypeError("Invalid telemetry period.");
  const from = parseDate(query.from, new Date(new Date(to).getTime() - PERIODS_MS[period]).toISOString());
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const rangeMs = toMs - fromMs;
  if (fromMs >= toMs || rangeMs > maxRangeMs) throw new TypeError("Invalid telemetry date range.");

  const normalized = { from, to };
  if (query.tenantId !== undefined) normalized.tenantId = pseudonym(query.tenantId, "t");
  if (query.installationId !== undefined) normalized.installationId = pseudonym(query.installationId, "i");
  if (!allowIdentityBeyondDetail && rangeMs > MAX_QUERY_MS && (normalized.tenantId || normalized.installationId)) {
    throw new TypeError("Identity filters are limited to detail retention.");
  }
  if (query.clientFamily !== undefined) {
    if (!isClientFamily(query.clientFamily)) throw new TypeError("Invalid telemetry client filter.");
    normalized.clientFamily = query.clientFamily;
  }
  if (query.toolGroup !== undefined) normalized.toolGroup = identifier(query.toolGroup);
  if (query.toolName !== undefined) normalized.toolName = identifier(query.toolName);
  if (query.outcome !== undefined) normalized.outcome = enumFilter(query.outcome, EVENT_OUTCOMES);
  if (query.eventType !== undefined) normalized.eventType = enumFilter(query.eventType, EVENT_TYPES);
  return Object.freeze(normalized);
}

function buildWhere(filters) {
  const clauses = ["occurred_at >= @from", "occurred_at < @to"];
  const params = { from: filters.from, to: filters.to };
  const columns = {
    tenantId: "tenant_id",
    installationId: "installation_id",
    clientFamily: "client_family",
    toolGroup: "tool_group",
    toolName: "tool_name",
    outcome: "outcome",
    eventType: "event_type",
  };
  for (const [key, column] of Object.entries(columns)) {
    if (filters[key] !== undefined) {
      clauses.push(`${column} = @${key}`);
      params[key] = filters[key];
    }
  }
  return { sql: `WHERE ${clauses.join(" AND ")}`, params };
}

function buildAggregateWhere(filters, bucket) {
  const isHourly = bucket === "hour";
  const clauses = isHourly
    ? ["hour_utc >= @fromBucket", "hour_utc < @toBucket"]
    : ["day_utc >= @fromBucket", "day_utc <= @toBucket"];
  const params = {
    fromBucket: isHourly ? hourBucket(filters.from) : filters.from.slice(0, 10),
    toBucket: isHourly ? filters.to : filters.to.slice(0, 10),
  };
  const columns = {
    clientFamily: "client_family",
    toolGroup: "tool_group",
    toolName: "tool_name",
    outcome: "outcome",
    eventType: "event_type",
  };
  for (const [key, column] of Object.entries(columns)) {
    if (filters[key] !== undefined) {
      clauses.push(`${column} = @${key}`);
      params[key] = filters[key];
    }
  }
  return { sql: `WHERE ${clauses.join(" AND ")}`, params };
}

function queryActivityWindows(database, normalized) {
  const windows = {};
  for (const period of ["24h", "7d", "30d", "90d"]) {
    const from = new Date(new Date(normalized.to).getTime() - PERIODS_MS[period]).toISOString();
    const windowFilters = { ...normalized, from };
    const windowWhere = buildWhere(windowFilters);
    const row = database.prepare(`
      SELECT
        COUNT(DISTINCT CASE WHEN event_type = 'tool_call_completed' AND outcome = 'success' THEN tenant_id END) AS active_tenants,
        COUNT(DISTINCT CASE WHEN event_type = 'tool_call_completed' AND outcome = 'success' THEN installation_id END) AS active_installations,
        SUM(CASE WHEN event_type = 'tool_call_completed' THEN 1 ELSE 0 END) AS tool_calls,
        COUNT(DISTINCT CASE WHEN event_type = 'tool_call_completed' AND outcome = 'success'
          THEN strftime('%Y-%m-%d', occurred_at, '+3 hours') END) AS active_days
      FROM telemetry_events
      ${windowWhere.sql}
    `).get(windowWhere.params);
    windows[period] = Object.freeze({
      activeTenants: number(row.active_tenants),
      activeInstallations: number(row.active_installations),
      toolCalls: number(row.tool_calls),
      activeDays: number(row.active_days),
    });
  }
  return windows;
}

function queryDetailActivity(database, normalized, filtered) {
  const rangeMs = new Date(normalized.to).getTime() - new Date(normalized.from).getTime();
  const hourly = rangeMs <= PERIODS_MS["24h"];
  const bucketExpression = hourly
    ? "substr(occurred_at, 1, 13) || ':00:00.000Z'"
    : "strftime('%Y-%m-%dT00:00:00+03:00', occurred_at, '+3 hours')";
  return database.prepare(`
    SELECT ${bucketExpression} AS bucket,
      COUNT(*) AS calls,
      SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successes
    FROM telemetry_events
    ${filtered.sql} AND event_type = 'tool_call_completed'
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(filtered.params).map(normalizeNumericRow);
}

function queryDetailHeatmap(database, filtered) {
  return database.prepare(`
    SELECT
      ((CAST(strftime('%w', occurred_at, '+3 hours') AS INTEGER) + 6) % 7) AS weekday,
      CAST(strftime('%H', occurred_at, '+3 hours') AS INTEGER) AS hour,
      COUNT(*) AS calls
    FROM telemetry_events
    ${filtered.sql} AND event_type = 'tool_call_completed'
    GROUP BY weekday, hour
    ORDER BY weekday ASC, hour ASC
  `).all(filtered.params).map(normalizeNumericRow);
}

function loadAnonymousDailySummary(database, normalized) {
  const params = { fromDay: normalized.from.slice(0, 10), toDay: normalized.to.slice(0, 10) };
  const result = new Map();
  const persisted = database.prepare(`
    SELECT day_utc AS dayUtc, active_tenants AS activeTenants,
      active_installations AS activeInstallations,
      identified_tool_calls AS identifiedToolCalls
    FROM telemetry_daily_summary
    WHERE day_utc >= @fromDay AND day_utc <= @toDay
  `).all(params);
  for (const row of persisted) result.set(row.dayUtc, normalizeNumericRow(row));

  // Detail rows override summaries while retained, keeping the current day and
  // late arrivals fresh without persisting identifiers in aggregate tables.
  const recent = database.prepare(`
    SELECT substr(occurred_at, 1, 10) AS dayUtc,
      COUNT(DISTINCT CASE WHEN event_type = 'tool_call_completed' AND outcome = 'success' THEN tenant_id END) AS activeTenants,
      COUNT(DISTINCT CASE WHEN event_type = 'tool_call_completed' AND outcome = 'success' THEN installation_id END) AS activeInstallations,
      SUM(CASE WHEN event_type = 'tool_call_completed' AND installation_id IS NOT NULL THEN 1 ELSE 0 END) AS identifiedToolCalls
    FROM telemetry_events
    WHERE occurred_at >= @from AND occurred_at < @to
    GROUP BY substr(occurred_at, 1, 10)
  `).all({ from: normalized.from, to: normalized.to });
  for (const row of recent) result.set(row.dayUtc, normalizeNumericRow(row));
  return result;
}

function hourBucket(iso) {
  return `${iso.slice(0, 13)}:00:00.000Z`;
}

function rowToEvent(row) {
  const event = {
    type: row.event_type,
    occurredAt: row.occurred_at,
  };
  const mappings = {
    request_id: "requestId",
    transport: "transport",
    tenant_id: "tenantId",
    installation_id: "installationId",
    client_family: "clientFamily",
    client_version: "clientVersion",
    mcp_method: "mcpMethod",
    tool_name: "toolName",
    tool_group: "toolGroup",
    tool_risk: "toolRisk",
    outcome: "outcome",
    error_code: "errorCode",
    upstream_status: "upstreamStatus",
    duration_ms: "durationMs",
    upstream_duration_ms: "upstreamDurationMs",
    limiter_wait_ms: "limiterWaitMs",
  };
  for (const [column, key] of Object.entries(mappings)) {
    if (row[column] !== null && row[column] !== undefined) event[key] = row[column];
  }
  return Object.freeze(event);
}

function normalizeNumericRow(row) {
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    result[key] = typeof value === "bigint" ? Number(value) : value;
  }
  return Object.freeze(result);
}

function parseDate(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || value.length > 32) throw new TypeError("Invalid telemetry date.");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid telemetry date.");
  return date.toISOString();
}

function pseudonym(value, prefix) {
  if (!isTelemetryPseudonym(value, prefix)) throw new TypeError("Invalid telemetry identity filter.");
  return value;
}

function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new TypeError("Invalid telemetry identifier filter.");
  }
  return value;
}

function enumFilter(value, values) {
  if (!values.includes(value)) throw new TypeError("Invalid telemetry enum filter.");
  return value;
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError("Invalid telemetry pagination value.");
  }
  return parsed;
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : number(value);
}

function number(value) {
  return Number(value ?? 0);
}
