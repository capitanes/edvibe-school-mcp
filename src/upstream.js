// Upstream HTTP client for Edvibe School API.
// Raw credentials, domains, URL/query values and response bodies never cross
// the telemetry boundary.

import { createHmac, randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import { performance } from "node:perf_hooks";
import { URL } from "node:url";
import {
  SafeMcpError,
  createSafeError,
  upstreamStatusToErrorCode,
} from "./telemetry/errors.js";

const BASE_PATH = "/school-api";
const RATE_LIMIT_RPS = 10;
const MAX_CONCURRENT = 4;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 5 * 1024 * 1024;
const DNS_CACHE_TTL_MS = 60_000;
const DNS_CACHE_MAX_ENTRIES = 1_000;
const LIMITER_IDLE_TTL_MS = 10 * 60_000;
const LIMITER_MAX_ENTRIES = 10_000;

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: REQUEST_TIMEOUT_MS,
});

// The process-random key keeps raw API keys out of the limiter registry. It is
// intentionally not stable across restarts and is never persisted or logged.
const limiterHashKey = randomBytes(32);
const limiterRegistry = new Map();
let overflowLimiter = null;

function limiterKey(apiKey) {
  return createHmac("sha256", limiterHashKey)
    .update("edvibe-rate-limit:v1:")
    .update(apiKey)
    .digest("base64url");
}

function pruneLimiterRegistry(now = Date.now()) {
  for (const [key, entry] of limiterRegistry) {
    if (entry.limiter.concurrent === 0 && now - entry.lastSeenAt > LIMITER_IDLE_TTL_MS) {
      limiterRegistry.delete(key);
    }
  }
  if (limiterRegistry.size < LIMITER_MAX_ENTRIES) return;
  const removable = [...limiterRegistry.entries()]
    .filter(([, entry]) => entry.limiter.concurrent === 0)
    .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt);
  for (const [key] of removable) {
    limiterRegistry.delete(key);
    if (limiterRegistry.size < LIMITER_MAX_ENTRIES) break;
  }
}

/** Return a per-credential limiter without retaining the raw API key. */
export function getLimiter(apiKey) {
  const now = Date.now();
  pruneLimiterRegistry(now);
  const key = limiterKey(apiKey);
  let entry = limiterRegistry.get(key);
  if (!entry) {
    if (limiterRegistry.size >= LIMITER_MAX_ENTRIES) {
      // A bounded fallback prevents attacker-controlled keys from growing the
      // registry without limit while preserving fail-safe rate limiting.
      overflowLimiter ??= new RateLimiter();
      return overflowLimiter;
    }
    entry = { limiter: new RateLimiter(), lastSeenAt: now };
    limiterRegistry.set(key, entry);
  }
  entry.lastSeenAt = now;
  return entry.limiter;
}

const RESERVED_HOSTNAMES = new Set(["localhost", "0.0.0.0", "::1", "[::1]"]);

function isIPLiteral(hostname) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith("[");
}

function isPrivateIP(ip) {
  const octets = typeof ip === "string" ? ip.split(".").map(Number) : [];
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true;
  }
  const [a, b, c] = octets;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

const dnsCache = new Map();

function pruneDnsCache(now = Date.now()) {
  for (const [hostname, entry] of dnsCache) {
    if (now - entry.timestamp >= DNS_CACHE_TTL_MS) dnsCache.delete(hostname);
  }
  while (dnsCache.size >= DNS_CACHE_MAX_ENTRIES) {
    const oldestKey = dnsCache.keys().next().value;
    if (oldestKey === undefined) break;
    dnsCache.delete(oldestKey);
  }
}

async function resolveHostname(hostname) {
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && now - cached.timestamp < DNS_CACHE_TTL_MS) return cached.addrs;
  pruneDnsCache(now);
  const addrs = await dns.resolve4(hostname);
  dnsCache.set(hostname, { addrs, timestamp: now });
  return addrs;
}

function normalizeHostname(hostname) {
  if (!hostname || typeof hostname !== "string") {
    throw createSafeError("missing_school_domain");
  }
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (
    normalized.length < 1 ||
    normalized.length > 253 ||
    normalized.includes("://") ||
    /[\/:?#@\s]/.test(normalized)
  ) {
    throw createSafeError("invalid_school_domain");
  }
  if (RESERVED_HOSTNAMES.has(normalized) || isIPLiteral(normalized)) {
    throw createSafeError("unsupported_school_domain");
  }
  return normalized;
}

/** Resolve and validate a bare public hostname without echoing it into errors. */
export async function resolveValidatedHostname(hostname) {
  const normalized = normalizeHostname(hostname);

  let addrs;
  try {
    addrs = await resolveHostname(normalized);
  } catch {
    throw createSafeError("domain_resolution_failed");
  }
  if (!Array.isArray(addrs) || addrs.length === 0 || addrs.some(isPrivateIP)) {
    throw createSafeError("unsupported_school_domain");
  }
  return Object.freeze({
    hostname: normalized,
    addresses: Object.freeze([...new Set(addrs)]),
    resolvedAt: Date.now(),
  });
}

/** Validate a hostname while keeping the legacy string return shape. */
export async function validateHostname(hostname) {
  return (await resolveValidatedHostname(hostname)).hostname;
}

function createPinnedLookup(address) {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  };
}

async function upstreamResolution(ctx) {
  const hostname = normalizeHostname(ctx.schoolDomain);
  if (Array.isArray(ctx.resolvedAddresses) && ctx.resolvedAddresses.length > 0) {
    if (ctx.resolvedAddresses.some(isPrivateIP)) throw createSafeError("unsupported_school_domain");
    return { hostname, addresses: [...new Set(ctx.resolvedAddresses)] };
  }
  return resolveValidatedHostname(hostname);
}

export class RateLimiter {
  constructor() {
    this.timestamps = [];
    this.concurrent = 0;
  }

  async acquire() {
    const started = performance.now();
    while (this.concurrent >= MAX_CONCURRENT) await sleep(50);
    this.timestamps = this.timestamps.filter((timestamp) => Date.now() - timestamp < 1_000);
    while (this.timestamps.length >= RATE_LIMIT_RPS) {
      await sleep(50);
      this.timestamps = this.timestamps.filter((timestamp) => Date.now() - timestamp < 1_000);
    }
    this.timestamps.push(Date.now());
    this.concurrent += 1;
    return performance.now() - started;
  }

  release() {
    this.concurrent = Math.max(0, this.concurrent - 1);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call Edvibe School API. Optional `metrics` is mutated only with safe numeric
 * timing/status fields and may be emitted by the tool telemetry handler.
 */
export async function callUpstream(ctx, method, apiPath, options = {}) {
  if (!ctx?.apiKey) throw createSafeError("missing_authorization");
  if (!ctx?.schoolDomain) throw createSafeError("missing_school_domain");
  const resolution = await upstreamResolution(ctx);

  const metrics = options.metrics && typeof options.metrics === "object" ? options.metrics : {};
  const limiter = getLimiter(ctx.apiKey);
  metrics.limiterWaitMs = await limiter.acquire();
  const started = performance.now();

  try {
    const fullPath = `${BASE_PATH}${apiPath}`;
    const url = new URL(`https://${resolution.hostname}${fullPath}`);
    for (const [key, value] of Object.entries(options.queryParams || {})) {
      if (value !== undefined && value !== null) url.searchParams.append(key, String(value));
    }

    const requestOptions = {
      method: method.toUpperCase(),
      headers: {
        Authorization: ctx.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: REQUEST_TIMEOUT_MS,
      agent: httpsAgent,
      lookup: createPinnedLookup(resolution.addresses[0]),
    };

    const bodyData = options.body === undefined ? undefined : JSON.stringify(options.body ?? {});
    return await new Promise((resolve, reject) => {
      const req = https.request(url, requestOptions, (res) => {
        metrics.upstreamStatus = res.statusCode;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume?.();
          reject(createSafeError(upstreamStatusToErrorCode(res.statusCode), { upstreamStatus: res.statusCode }));
          return;
        }
        let data = "";
        let responseBytes = 0;
        let responseSettled = false;
        res.on("data", (chunk) => {
          if (responseSettled) return;
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > MAX_UPSTREAM_RESPONSE_BYTES) {
            responseSettled = true;
            data = "";
            res.destroy?.();
            reject(createSafeError("upstream_non_json", { upstreamStatus: res.statusCode }));
            return;
          }
          data += chunk;
        });
        res.on("end", () => {
          if (responseSettled) return;
          responseSettled = true;

          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            reject(createSafeError("upstream_non_json", { upstreamStatus: res.statusCode }));
            return;
          }

          if (parsed && typeof parsed === "object" && "errorStackTrace" in parsed) {
            delete parsed.errorStackTrace;
          }
          if (parsed && parsed.isSuccess === false) {
            reject(createSafeError("upstream_business_error", { upstreamStatus: res.statusCode }));
            return;
          }
          resolve(parsed);
        });
      });

      req.on("error", (error) => {
        reject(error instanceof SafeMcpError ? error : createSafeError("upstream_network"));
      });
      req.on("timeout", () => {
        req.destroy(createSafeError("upstream_timeout"));
      });
      if (bodyData !== undefined) req.write(bodyData);
      req.end();
    });
  } finally {
    metrics.upstreamDurationMs = performance.now() - started;
    limiter.release();
  }
}

/** Test-only observability without exposing registry keys or hostnames. */
export function getUpstreamCacheStats() {
  return Object.freeze({ limiterEntries: limiterRegistry.size, dnsEntries: dnsCache.size });
}
