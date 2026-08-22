// Empirically verified required body field overrides.
//
// The upstream OpenAPI marks several request body fields as optional that the
// live Edvibe School API actually rejects. This module is the single,
// reproducible, human-authored source of truth for those overrides. It is
// consumed by generate-manifest.cjs, normalize.cjs and src/tool-definitions.js
// so that manifest, normalized spec and MCP tool input schema all agree.
//
// Adding an override here is ONLY permitted when the requirement has been
// confirmed by a safe, recorded probe against the live API on the configured
// school (see CONTEXT.md → "Расхождения upstream OpenAPI vs live-поведение").
// Do NOT tighten requiredness based on guesses or help-center wording alone.
//
// Keyed by stable operationId (matches manifest/operations.json). Each value
// is the list of body field names (in upstream casing) that must be treated as
// required in addition to whatever the upstream schema already declares.

"use strict";

/**
 * @typedef {Record<string, string[]>} RequiredOverrides
 * Maps operationId → array of body field names to mark as required.
 *
 * Each entry MUST have a matching justification recorded in CONTEXT.md under
 * "Расхождения upstream OpenAPI vs live-поведение" with:
 *   - operationId and HTTP method/path;
 *   - minimal request body that triggered the failure;
 *   - observed HTTP status and upstream errorMessage;
 *   - date and school domain used for the probe.
 */

/** @type {RequiredOverrides} */
const REQUIRED_OVERRIDES = {
  // Confirmed 2026-08-22 against https://edvibe.com (private pilot):
  //   POST /api/Pupils/Create with body { name, isActive: false } → HTTP 500
  //   with empty response body. Adding `email` makes the call succeed
  //   (returned id 3577069..3577073 in the probe). Upstream schema lists only
  //   `name` as required and marks `email` optional.
  PupilsCreate: ["email"],

  // Confirmed 2026-08-22 against https://edvibe.com (private pilot):
  //   POST /api/Teachers/Create with body { name } → HTTP 400 with
  //   BaseResponse.isSuccess=false and errorMessage
  //   "Введённый адрес электронной почты является некорректным".
  //   Adding `email` makes the call succeed (returned id 3577063..3577067).
  //   Upstream schema marks `email` optional.
  TeachersCreate: ["email"],
};

/**
 * Return the override list for an operationId, or an empty array if none.
 * @param {string} operationId
 * @returns {string[]}
 */
function requiredOverridesFor(operationId) {
  return REQUIRED_OVERRIDES[operationId] || [];
}

module.exports = { REQUIRED_OVERRIDES, requiredOverridesFor };
