/**
 * Safe, finite error taxonomy for MCP responses and telemetry.
 *
 * This module deliberately never derives a public or telemetry message from an
 * arbitrary Error. Callers may keep the original error in process-local
 * control flow, but only the allow-listed code/status returned here may cross
 * the logging boundary.
 */

export const ERROR_DEFINITIONS = Object.freeze({
  missing_authorization: { httpStatus: 401, publicMessage: "Authorization is required." },
  invalid_authorization: { httpStatus: 401, publicMessage: "Authorization is invalid." },
  missing_school_domain: { httpStatus: 400, publicMessage: "School domain is required." },
  invalid_school_domain: { httpStatus: 400, publicMessage: "School domain is invalid." },
  unsupported_school_domain: { httpStatus: 403, publicMessage: "School domain is not allowed." },
  domain_resolution_failed: { httpStatus: 400, publicMessage: "School domain could not be resolved." },
  malformed_json: { httpStatus: 400, publicMessage: "Malformed JSON body." },
  request_body_too_large: { httpStatus: 413, publicMessage: "Request body is too large." },
  invalid_request: { httpStatus: 400, publicMessage: "Request is invalid." },
  method_not_allowed: { httpStatus: 405, publicMessage: "Method is not allowed." },
  unknown_tool: { httpStatus: 400, publicMessage: "Unknown tool." },
  invalid_arguments: { httpStatus: 400, publicMessage: "Tool arguments are invalid." },
  upstream_401: { httpStatus: 502, upstreamStatus: 401, publicMessage: "Upstream authorization failed." },
  upstream_403: { httpStatus: 502, upstreamStatus: 403, publicMessage: "Upstream access was denied." },
  upstream_429: { httpStatus: 503, upstreamStatus: 429, publicMessage: "Upstream rate limit was reached." },
  upstream_4xx: { httpStatus: 502, publicMessage: "Upstream rejected the request." },
  upstream_5xx: { httpStatus: 502, publicMessage: "Upstream service failed." },
  upstream_timeout: { httpStatus: 504, publicMessage: "Upstream request timed out." },
  upstream_network: { httpStatus: 502, publicMessage: "Upstream network request failed." },
  upstream_non_json: { httpStatus: 502, publicMessage: "Upstream returned an invalid response." },
  upstream_business_error: { httpStatus: 422, publicMessage: "Upstream could not complete the operation." },
  telemetry_queue_full: { httpStatus: 500, publicMessage: "Telemetry storage is degraded." },
  telemetry_queue_closed: { httpStatus: 500, publicMessage: "Telemetry storage is degraded." },
  telemetry_write_failed: { httpStatus: 500, publicMessage: "Telemetry storage is degraded." },
  telemetry_database_unavailable: { httpStatus: 500, publicMessage: "Telemetry storage is unavailable." },
  telemetry_maintenance_failed: { httpStatus: 500, publicMessage: "Telemetry maintenance failed." },
  telemetry_invalid_event: { httpStatus: 500, publicMessage: "Telemetry event was rejected." },
  internal_error: { httpStatus: 500, publicMessage: "Internal Server Error." },
});

export const ERROR_CODES = Object.freeze(Object.keys(ERROR_DEFINITIONS));
const ERROR_CODE_SET = new Set(ERROR_CODES);

/** Return true only for a code from the public finite taxonomy. */
export function isSafeErrorCode(code) {
  return typeof code === "string" && ERROR_CODE_SET.has(code);
}

/**
 * Error that exposes only an allow-listed code and fixed public message.
 * Raw upstream bodies, arguments, domains, credentials, stack traces and
 * arbitrary cause messages are intentionally not copied onto the instance.
 */
export class SafeMcpError extends Error {
  constructor(code, options = {}) {
    const definition = ERROR_DEFINITIONS[code];
    if (!definition) {
      throw new TypeError("Unknown safe error code.");
    }

    super(definition.publicMessage);
    this.name = "SafeMcpError";
    this.code = code;
    this.httpStatus = definition.httpStatus;
    this.upstreamStatus = normalizeUpstreamStatus(options.upstreamStatus ?? definition.upstreamStatus);
    this.retryable = options.retryable === true;

    // A cause may be useful to application control flow, but must never be
    // enumerable or serialized by a telemetry/event spread.
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
  }

  toJSON() {
    return {
      code: this.code,
      httpStatus: this.httpStatus,
      upstreamStatus: this.upstreamStatus,
      retryable: this.retryable,
      message: this.message,
    };
  }
}

/** Create a SafeMcpError without accepting a caller-provided message. */
export function createSafeError(code, options) {
  return new SafeMcpError(code, options);
}

/**
 * Convert any error into a safe, serializable classification.
 * Unknown errors always collapse to `internal_error`; their text and stack are
 * never inspected or returned.
 */
export function classifySafeError(error) {
  if (error instanceof SafeMcpError) {
    return Object.freeze({
      code: error.code,
      httpStatus: error.httpStatus,
      upstreamStatus: error.upstreamStatus,
      retryable: error.retryable,
      publicMessage: error.message,
    });
  }

  return Object.freeze({
    code: "internal_error",
    httpStatus: ERROR_DEFINITIONS.internal_error.httpStatus,
    upstreamStatus: null,
    retryable: false,
    publicMessage: ERROR_DEFINITIONS.internal_error.publicMessage,
  });
}

/** Map an upstream HTTP status to the finite telemetry taxonomy. */
export function upstreamStatusToErrorCode(status) {
  const normalized = normalizeUpstreamStatus(status);
  if (normalized === 401) return "upstream_401";
  if (normalized === 403) return "upstream_403";
  if (normalized === 429) return "upstream_429";
  if (normalized !== null && normalized >= 400 && normalized < 500) return "upstream_4xx";
  if (normalized !== null && normalized >= 500 && normalized < 600) return "upstream_5xx";
  return "internal_error";
}

function normalizeUpstreamStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

