// Normalizes the immutable upstream OpenAPI snapshot into an MCP-friendly copy.
//
// Input:
//   - openapi/snapshots/<latest>.json (immutable upstream)
//   - manifest/operations.json (authoritative operationId + risk class)
// Output:
//   - openapi/normalized/edvibe-school-api.normalized.json (generated, do not edit)
//
// Normalization is reproducible: running this script again from the same inputs
// produces a byte-identical output (modulo generatedAt timestamp).
//
// What this script does (and does NOT do):
//   - Adds stable English operationId to every operation.
//   - Renames security scheme "Bearer" -> "EdvibeApiKey" without changing upstream
//     semantics (apiKey in Authorization header, raw key, no Bearer prefix upstream).
//   - Introduces a server variable for the school domain so the spec is tenant-agnostic.
//   - Maps dotted parameters (e.g. Page.Skip) to flat, MCP-friendly inputs and records
//     the reverse mapping in x-edvibe-param-map for the future MCP server.
//   - Adds English descriptions and risk warnings to every operation.
//   - Tags every operation with its group; explicitly preserves the Marathon tag.
//   - Does NOT change requiredness of request bodies without confirmation.
//   - Does NOT edit the snapshot.
//
// Run: node scripts/normalize.js

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { descriptionFor } = require("./operation-meta");

const ROOT = path.resolve(__dirname, "..");
const SNAPSHOTS_DIR = path.join(ROOT, "openapi", "snapshots");
const MANIFEST_PATH = path.join(ROOT, "manifest", "operations.json");
const OUT_DIR = path.join(ROOT, "openapi", "normalized");
const OUT_PATH = path.join(OUT_DIR, "edvibe-school-api.normalized.json");

/** Latest snapshot path. */
function latestSnapshot() {
  const files = fs
    .readdirSync(SNAPSHOTS_DIR)
    .filter((f) => /^swagger-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (!files.length) throw new Error("No snapshot found in openapi/snapshots");
  return path.join(SNAPSHOTS_DIR, files[files.length - 1]);
}

/** Map dotted parameter names to flat MCP-friendly names. */
const DOTTED_PARAM_MAP = {
  "Page.Skip": "pageSkip",
  "Page.Take": "pageTake",
  "Cursor.AfterId": "cursorAfterId",
  "Cursor.BeforeId": "cursorBeforeId",
  "Cursor.Limit": "cursorLimit",
  "Cursor.MaxLimit": "cursorMaxLimit",
};

function main() {
  const snapshotPath = latestSnapshot();
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

  // Index manifest by "METHOD path".
  /** @type {Record<string, any>} */
  const byKey = {};
  for (const op of manifest.operations) byKey[`${op.method} ${op.path}`] = op;

  // Deep clone snapshot.
  const norm = JSON.parse(JSON.stringify(snapshot));

  // info: keep upstream, append MCP note.
  norm.info = norm.info || {};
  norm.info.title = norm.info.title || "Edvibe School API";
  norm.info.description =
    "Normalized MCP-oriented copy of the Edvibe School API. Generated from the immutable upstream snapshot; do not edit by hand. Risk classifications and operationIds come from manifest/operations.json.";

  // servers: introduce a tenant-agnostic server variable for the school domain.
  norm.servers = [
    {
      url: "https://{schoolDomain}/school-api",
      variables: {
        schoolDomain: {
          description: "Hostname of the school's Edvibe or White Label domain. HTTPS only, port 443, no scheme/path/port.",
          default: "<SCHOOL_HOSTNAME>",
        },
      },
    },
  ];

  // securitySchemes: rename Bearer -> EdvibeApiKey, keep semantics.
  if (norm.components && norm.components.securitySchemes && norm.components.securitySchemes.Bearer) {
    const original = norm.components.securitySchemes.Bearer;
    norm.components.securitySchemes.EdvibeApiKey = {
      type: "apiKey",
      description:
        "Edvibe School API key passed as a raw value in the Authorization header (no Bearer prefix upstream). The MCP server accepts Authorization: Bearer <EDVIBE_API_KEY> and strips the prefix before calling upstream.",
      name: "Authorization",
      in: "header",
      "x-edvibe-original-name": "Bearer",
    };
    delete norm.components.securitySchemes.Bearer;
  }
  norm.security = [{ EdvibeApiKey: [] }];

  // Walk paths and apply manifest-driven changes.
  /** @type {Array<string>} */
  const errors = [];
  let opCount = 0;
  for (const [pathStr, methods] of Object.entries(norm.paths || {})) {
    for (const method of Object.keys(methods)) {
      if (!["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method)) continue;
      const op = methods[method];
      const key = `${method.toUpperCase()} ${pathStr}`;
      const m = byKey[key];
      if (!m) {
        errors.push(`Operation in snapshot but not in manifest: ${key}`);
        continue;
      }
      opCount += 1;

      // operationId
      op.operationId = m.operationId;

      // tags: ensure group tag is present; preserve Marathon explicitly.
      const tags = new Set(op.tags || []);
      tags.add(m.group);
      if (m.group === "Marathon") tags.add("Marathon");
      op.tags = [...tags].sort();

      // English description + risk warning (shared with manifest).
      const desc = descriptionFor(m.operationId);
      if (desc) op.description = desc;

      // x-edvibe-risk: machine-readable risk class for tooling.
      op["x-edvibe-risk"] = m.riskClass;
      op["x-edvibe-annotations"] = m.annotations;

      // Dotted parameter flattening: record mapping, do not change schema yet.
      if (Array.isArray(op.parameters)) {
        /** @type {Array<{from:string,to:string}>} */
        const mapped = [];
        for (const p of op.parameters) {
          if (DOTTED_PARAM_MAP[p.name]) {
            mapped.push({ from: p.name, to: DOTTED_PARAM_MAP[p.name] });
          }
        }
        if (mapped.length) op["x-edvibe-param-map"] = mapped;
      }
    }
  }

  if (opCount !== manifest.counts.total) {
    errors.push(`Normalized op count ${opCount} != manifest total ${manifest.counts.total}`);
  }
  if (errors.length) {
    console.error("Normalization failed:");
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = {
    snapshot: manifest.snapshot,
    openapi: norm,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
  const sha = crypto.createHash("sha256").update(fs.readFileSync(OUT_PATH)).digest("hex");
  console.log("Normalized spec written:", path.relative(ROOT, OUT_PATH));
  console.log("Operations normalized:", opCount);
  console.log("SHA-256:", sha);
}

main();
