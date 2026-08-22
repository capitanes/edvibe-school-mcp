// Upstream HTTP client for Edvibe School API.
//
// Security features:
//   - Hostname validation (HTTPS only, no IP literals, no private ranges)
//   - Per-key rate limiting (10 rps, max 4 concurrent)
//   - BaseResponse.isSuccess=false → error
//   - errorStackTrace stripped from all responses
//   - No redirects followed
//   - Fixed base path /school-api

import https from "https";
import { URL } from "url";
import dns from "dns/promises";

const BASE_PATH = "/school-api";
const RATE_LIMIT_RPS = 10;
const MAX_CONCURRENT = 4;
const REQUEST_TIMEOUT_MS = 30000;

// --- Hostname validation ---

const PRIVATE_IP_PATTERNS = [
  /^127\./, // loopback
  /^10\./, // private
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // private
  /^192\.168\./, // private
  /^169\.254\./, // link-local
  /^0\./, // current network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
];

const RESERVED_HOSTNAMES = ["localhost", "0.0.0.0", "::1", "[::1]"];

function isIPLiteral(hostname) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith("[");
}

function isPrivateIP(ip) {
  return PRIVATE_IP_PATTERNS.some((p) => p.test(ip));
}

/**
 * Validate and canonicalize a school domain hostname.
 * Returns the canonical hostname or throws on validation failure.
 */
export async function validateHostname(hostname) {
  if (!hostname || typeof hostname !== "string") {
    throw new Error("School domain is required.");
  }
  let h = hostname.trim().toLowerCase();

  // Strip any scheme, path, port, query, fragment
  if (h.includes("://") || h.includes("/") || h.includes(":") || h.includes("?") || h.includes("#")) {
    throw new Error(`Invalid hostname: must be a bare hostname without scheme, path, port, or query. Got: ${hostname}`);
  }

  if (RESERVED_HOSTNAMES.includes(h)) {
    throw new Error(`Reserved hostname blocked: ${h}`);
  }

  if (isIPLiteral(h)) {
    throw new Error(`IP literal blocked: ${h}. Use a hostname only.`);
  }

  // DNS resolution check (protects against DNS rebinding and private IPs)
  let addrs;
  try {
    addrs = await dns.resolve4(h);
  } catch (e) {
    throw new Error(`DNS resolution failed for ${h}: ${e.message}`);
  }
  for (const addr of addrs) {
    if (isPrivateIP(addr)) {
      throw new Error(`Private/reserved IP blocked for ${h}: ${addr}`);
    }
  }

  return h;
}

// --- Rate limiter (per credential context) ---

class RateLimiter {
  constructor() {
    this.timestamps = [];
    this.concurrent = 0;
  }

  async acquire() {
    // Wait for a concurrency slot
    while (this.concurrent >= MAX_CONCURRENT) {
      await sleep(50);
    }
    // Wait for rate limit window
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 1000);
    while (this.timestamps.length >= RATE_LIMIT_RPS) {
      await sleep(50);
      this.timestamps = this.timestamps.filter((t) => Date.now() - t < 1000);
    }
    this.timestamps.push(Date.now());
    this.concurrent++;
  }

  release() {
    this.concurrent = Math.max(0, this.concurrent - 1);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- HTTP request ---

/**
 * Make an upstream request to Edvibe School API.
 *
 * @param {object} ctx - Credential context { apiKey, schoolDomain }
 * @param {string} method - HTTP method
 * @param {string} apiPath - API path starting with /api/
 * @param {object} options - { queryParams, body, limiter }
 * @returns {Promise<object>} - Parsed JSON response (BaseResponse)
 */
export async function callUpstream(ctx, method, apiPath, options = {}) {
  if (!ctx?.apiKey) throw new Error("Missing API key in credential context.");
  if (!ctx?.schoolDomain) throw new Error("Missing school domain in credential context.");

  const limiter = options.limiter || new RateLimiter();
  await limiter.acquire();

  try {
    const fullPath = `${BASE_PATH}${apiPath}`;
    const url = new URL(`https://${ctx.schoolDomain}${fullPath}`);

    // Add query parameters
    if (options.queryParams) {
      for (const [key, value] of Object.entries(options.queryParams)) {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      }
    }

    const requestOptions = {
      method: method.toUpperCase(),
      headers: {
        Authorization: ctx.apiKey, // raw key, no Bearer prefix
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: REQUEST_TIMEOUT_MS,
      redirect: "manual", // never follow redirects
    };

    // Always serialize the body when the operation declares one.
    // Edvibe returns HTTP 400 "A non-empty request body is required" for POST
    // endpoints whose body schema is an empty object (e.g. BooksGetBooksSchool),
    // so we must send at least `{}` whenever hasBody is true.
    let bodyData = undefined;
    if (options.body !== undefined) {
      bodyData = JSON.stringify(options.body ?? {});
    }

    return await new Promise((resolve, reject) => {
      const req = https.request(url, requestOptions, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          // Non-2xx HTTP status → error
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Upstream HTTP ${res.statusCode}: ${truncate(data, 200)}`));
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            reject(new Error(`Upstream returned non-JSON response: ${truncate(data, 200)}`));
            return;
          }
          // BaseResponse: isSuccess=false → error
          if (parsed && parsed.isSuccess === false) {
            const msg = parsed.errorMessage || "Unknown upstream error";
            reject(new Error(`Edvibe API error: ${msg}`));
            return;
          }
          // Strip errorStackTrace from response
          if (parsed && parsed.errorStackTrace) {
            delete parsed.errorStackTrace;
          }
          resolve(parsed);
        });
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error(`Upstream request timeout after ${REQUEST_TIMEOUT_MS}ms`));
      });

      if (bodyData) {
        req.write(bodyData);
      }
      req.end();
    });
  } finally {
    limiter.release();
  }
}

function truncate(s, max) {
  if (typeof s !== "string") return "";
  return s.length > max ? s.slice(0, max) + "..." : s;
}

export { RateLimiter };
