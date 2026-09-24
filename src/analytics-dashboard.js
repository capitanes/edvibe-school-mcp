// Read-only analytics dashboard served by the HTTP MCP process.
//
// The dashboard never receives or exposes MCP credentials, tool arguments,
// response bodies, raw domains, installation UUIDs, IP addresses, or user agents.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.resolve(__dirname, "..", "web", "admin");
const DASHBOARD_USER = "analytics";
const RANGE_VALUES = new Set(["24h", "7d", "30d", "90d", "365d"]);
const CLIENT_FAMILIES = new Set(["cursor", "codex", "devin", "other", "unknown"]);
const OUTCOMES = new Set(["success", "error", "rejected", "cancelled"]);

const ASSETS = new Map([
  ["/admin/analytics", ["analytics.html", "text/html; charset=utf-8"]],
  ["/admin/analytics/", ["analytics.html", "text/html; charset=utf-8"]],
  ["/admin/analytics/analytics.css", ["analytics.css", "text/css; charset=utf-8"]],
  ["/admin/analytics/analytics.js", ["analytics.js", "text/javascript; charset=utf-8"]],
]);

function securityHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  res.end(JSON.stringify(payload));
}

function sendUnauthorized(res) {
  if (res.headersSent) return;
  res.writeHead(401, {
    ...securityHeaders("application/json; charset=utf-8"),
    "WWW-Authenticate": 'Basic realm="Edvibe MCP analytics", charset="UTF-8"',
  });
  res.end(JSON.stringify({ error: "Authentication required." }));
}

function parseBasicCredentials(header) {
  if (typeof header !== "string" || !header.startsWith("Basic ")) return null;
  try {
    const encoded = header.slice(6);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

function isAuthorized(header, telemetryOrPassword) {
  const credentials = parseBasicCredentials(header);
  if (!credentials) return false;
  if (typeof telemetryOrPassword?.verifyDashboardCredentials !== "function") return false;
  return telemetryOrPassword.verifyDashboardCredentials(credentials.username, credentials.password);
}

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isHttpsRequest(req, config) {
  if (config.analyticsRequireHttps === false) return true;
  if (req.socket?.encrypted) return true;
  if (!isTrustedProxyAddress(req.socket?.remoteAddress)) return false;
  const forwardedProto = firstHeader(req.headers["x-forwarded-proto"]);
  return typeof forwardedProto === "string" && forwardedProto.split(",")[0].trim().toLowerCase() === "https";
}

function isTrustedProxyAddress(address) {
  if (typeof address !== "string") return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (normalized === "::1" || normalized === "127.0.0.1") return true;
  if (/^10\./.test(normalized) || /^192\.168\./.test(normalized)) return true;
  const match = normalized.match(/^172\.(\d{1,3})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function cleanPseudoId(value, prefix) {
  if (!value) return undefined;
  const normalized = String(value).trim();
  return new RegExp(`^${prefix}_[A-Za-z0-9_-]{22}$`).test(normalized) ? normalized : undefined;
}

function cleanEnum(value, allowed) {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  return allowed.has(normalized) ? normalized : undefined;
}

function cleanGroup(value) {
  if (!value) return undefined;
  const normalized = String(value).trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(normalized) ? normalized : undefined;
}

function parseFilters(searchParams) {
  const period = RANGE_VALUES.has(searchParams.get("range")) ? searchParams.get("range") : "7d";
  return {
    period,
    tenantId: cleanPseudoId(searchParams.get("tenant_id"), "t"),
    installationId: cleanPseudoId(searchParams.get("installation_id"), "i"),
    clientFamily: cleanEnum(searchParams.get("client_family"), CLIENT_FAMILIES),
    toolGroup: cleanGroup(searchParams.get("tool_group")),
    outcome: cleanEnum(searchParams.get("outcome"), OUTCOMES),
  };
}

function parseEventsQuery(searchParams) {
  const filters = parseFilters(searchParams);
  const requestedLimit = Number.parseInt(searchParams.get("limit") || "50", 10);
  const cursor = Number.parseInt(searchParams.get("cursor") || "1", 10);
  return {
    ...filters,
    pageSize: Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50,
    page: Number.isFinite(cursor) && cursor > 0 ? cursor : 1,
  };
}

function readAsset(fileName) {
  return fs.readFileSync(path.join(ASSET_DIR, fileName));
}

function ratio(successes, calls) {
  return Number(calls) > 0 ? Number(successes || 0) / Number(calls) : 0;
}

function adaptDashboard(raw, status) {
  const totals = raw?.totals || {};
  const activity = raw?.activity || (raw?.daily || []).map((row) => ({
    bucket: row.bucket || row.dayUtc,
    calls: Number(row.calls || 0),
    successfulCalls: Number(row.successes || row.successfulCalls || 0),
  }));
  const tools = (raw?.tools || []).map((row) => ({
    ...row,
    successRate: row.successRate ?? ratio(row.successes, row.calls),
    p95Ms: row.p95Ms ?? null,
  }));
  const clients = (raw?.clients || []).map((row) => ({
    ...row,
    successRate: row.successRate ?? ratio(row.successes, row.calls),
  }));

  return {
    generatedAt: new Date().toISOString(),
    range: raw?.range || null,
    activityWindows: raw?.activityWindows || {},
    summary: {
      activeTenants: totals.activeTenants == null ? null : Number(totals.activeTenants),
      activeInstallations: totals.activeInstallations == null ? null : Number(totals.activeInstallations),
      initializationCount: Number(totals.initializations || 0),
      toolCalls: Number(totals.toolCalls || 0),
      successRate: Number(totals.successRate || 0),
      p50Ms: totals.p50DurationMs ?? null,
      p95Ms: totals.p95DurationMs ?? null,
      installationCoverage: totals.identifiedShare == null ? null : Number(totals.identifiedShare),
    },
    operational: {
      storageStatus: status?.state || "unavailable",
      droppedEvents: Number(status?.droppedEvents || 0),
      dbSizeBytes: Number(status?.dbSizeBytes || 0),
      lastEventAt: status?.lastEventAt || null,
    },
    activity,
    heatmap: raw?.heatmap || raw?.moscowHeatmap || [],
    tools,
    groups: raw?.groups || [],
    errors: raw?.errors || [],
    scenarios: raw?.scenarios?.items || raw?.scenarios || [],
    clients,
  };
}

function adaptEvents(raw) {
  const page = Number(raw?.page || 1);
  const pages = Number(raw?.pages || 0);
  return {
    items: raw?.items || [],
    total: Number(raw?.total || 0),
    nextCursor: page < pages ? String(page + 1) : null,
  };
}

/**
 * Handle an /admin/analytics request.
 *
 * @returns {Promise<boolean>} true when the route belongs to the dashboard.
 */
export async function handleAnalyticsRequest(req, res, url, telemetry) {
  if (url.pathname !== "/admin/analytics" && !url.pathname.startsWith("/admin/analytics/")) return false;

  const config = telemetry?.config || {};
  if (!telemetry?.dashboardEnabled || !config.dashboardEnabled) {
    sendJson(res, 404, { error: "Not Found." });
    return true;
  }

  if (!isHttpsRequest(req, config)) {
    sendJson(res, 403, { error: "HTTPS is required." });
    return true;
  }

  if (!isAuthorized(req.headers.authorization, telemetry)) {
    sendUnauthorized(res);
    return true;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { ...securityHeaders("application/json; charset=utf-8"), Allow: "GET" });
    res.end(JSON.stringify({ error: "Method Not Allowed." }));
    return true;
  }

  try {
    if (url.pathname === "/admin/analytics/api/dashboard") {
      const filters = parseFilters(url.searchParams);
      if (filters.period === "365d" && (filters.tenantId || filters.installationId)) {
        sendJson(res, 400, { error: "Identity filters are available for up to 90 days." });
        return true;
      }
      const dashboard = await telemetry.getDashboard(filters);
      sendJson(res, 200, adaptDashboard(dashboard, telemetry.getStatus()));
      return true;
    }

    if (url.pathname === "/admin/analytics/api/events") {
      const filters = parseEventsQuery(url.searchParams);
      const events = await telemetry.getEvents(filters);
      sendJson(res, 200, adaptEvents(events));
      return true;
    }

    const asset = ASSETS.get(url.pathname);
    if (!asset) {
      sendJson(res, 404, { error: "Not Found." });
      return true;
    }
    const [fileName, contentType] = asset;
    const body = readAsset(fileName);
    res.writeHead(200, securityHeaders(contentType));
    res.end(body);
    return true;
  } catch {
    sendJson(res, 500, { error: "Analytics dashboard is temporarily unavailable." });
    return true;
  }
}

export {
  DASHBOARD_USER,
  adaptDashboard,
  adaptEvents,
  isAuthorized,
  parseBasicCredentials,
  parseEventsQuery,
  parseFilters,
};
