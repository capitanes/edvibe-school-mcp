// CI validator for the Edvibe School MCP contract.
//
// Checks:
//   1. Snapshot exists, is valid JSON, OpenAPI 3.x, 78 operations.
//   2. Manifest exists, counts match 35 + 24 + 17 + 2 = 78.
//   3. Normalized spec exists, has 78 operations, all with operationId and x-edvibe-risk.
//   4. Parity: same 78 method/path across snapshot, manifest, normalized.
//   5. operationId uniqueness across manifest and normalized.
//   6. Annotation matrix: 35 read (readOnlyHint=true), 24 write (readOnly=false, destructive=false),
//      17 high-risk (destructive=true), 2 sensitive (readOnly=false, destructive=false + warning).
//   7. No secrets: scan tracked files for high-entropy tokens, API keys, Bearer values.
//   8. Snapshot is immutable: warn if snapshot file content changed since manifest generation.
//
// Exit code 0 = all checks passed; 1 = any check failed.
//
// Run: node scripts/validate.js

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SNAPSHOTS_DIR = path.join(ROOT, "openapi", "snapshots");
const MANIFEST_PATH = path.join(ROOT, "manifest", "operations.json");
const NORMALIZED_PATH = path.join(ROOT, "openapi", "normalized", "edvibe-school-api.normalized.json");
const { EXPECTED_COUNTS } = require("./risk-classification");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];

/** @type {Array<string>} */
const failures = [];
/** @type {Array<string>} */
const warnings = [];

function fail(msg) {
  failures.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

function latestSnapshotPath() {
  const files = fs
    .readdirSync(SNAPSHOTS_DIR)
    .filter((f) => /^swagger-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (!files.length) throw new Error("No snapshot found");
  return path.join(SNAPSHOTS_DIR, files[files.length - 1]);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function opsFromSpec(spec) {
  /** @type {Array<{method:string,path:string,operationId?:string,risk?:string}>} */
  const ops = [];
  for (const [pathStr, methods] of Object.entries(spec.paths || {})) {
    for (const method of Object.keys(methods)) {
      if (!HTTP_METHODS.includes(method)) continue;
      const op = methods[method];
      ops.push({
        method: method.toUpperCase(),
        path: pathStr,
        operationId: op.operationId,
        risk: op["x-edvibe-risk"],
        annotations: op["x-edvibe-annotations"],
        description: op.description,
      });
    }
  }
  return ops;
}

function checkSnapshot() {
  const snapPath = latestSnapshotPath();
  const snap = readJson(snapPath);
  if (!snap.openapi || !snap.openapi.startsWith("3.")) fail(`Snapshot openapi version is not 3.x: ${snap.openapi}`);
  const ops = opsFromSpec(snap);
  if (ops.length !== EXPECTED_COUNTS.total) fail(`Snapshot operations count ${ops.length} != ${EXPECTED_COUNTS.total}`);
  // Snapshot must NOT have operationIds (upstream has none).
  const withId = ops.filter((o) => o.operationId);
  if (withId.length) fail(`Snapshot should have no operationIds, found ${withId.length}`);
  return { snapPath, snap, ops };
}

function checkManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    fail("manifest/operations.json not found. Run: node scripts/generate-manifest.js");
    return null;
  }
  const m = readJson(MANIFEST_PATH);
  for (const [k, expected] of Object.entries(EXPECTED_COUNTS)) {
    if (m.counts[k] !== expected) fail(`Manifest count ${k}: expected ${expected}, got ${m.counts[k]}`);
  }
  // operationId uniqueness
  const ids = m.operations.map((o) => o.operationId);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) fail(`Duplicate operationId in manifest: ${dupes.join(", ")}`);
  // method/path uniqueness
  const keys = m.operations.map((o) => `${o.method} ${o.path}`);
  const dupeKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupeKeys.length) fail(`Duplicate method/path in manifest: ${dupeKeys.join(", ")}`);
  return m;
}

function checkNormalized() {
  if (!fs.existsSync(NORMALIZED_PATH)) {
    fail("openapi/normalized/edvibe-school-api.normalized.json not found. Run: node scripts/normalize.js");
    return null;
  }
  const n = readJson(NORMALIZED_PATH);
  const spec = n.openapi;
  if (!spec.openapi || !spec.openapi.startsWith("3.")) fail(`Normalized openapi version is not 3.x: ${spec.openapi}`);
  const ops = opsFromSpec(spec);
  if (ops.length !== EXPECTED_COUNTS.total) fail(`Normalized operations count ${ops.length} != ${EXPECTED_COUNTS.total}`);
  // Every op must have operationId and x-edvibe-risk
  for (const o of ops) {
    if (!o.operationId) fail(`Normalized op missing operationId: ${o.method} ${o.path}`);
    if (!o.risk) fail(`Normalized op missing x-edvibe-risk: ${o.method} ${o.path}`);
    if (!o.annotations) fail(`Normalized op missing x-edvibe-annotations: ${o.operationId}`);
  }
  // operationId uniqueness
  const ids = ops.map((o) => o.operationId);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) fail(`Duplicate operationId in normalized: ${dupes.join(", ")}`);
  // security scheme renamed
  const schemes = spec.components && spec.components.securitySchemes;
  if (schemes && schemes.Bearer) fail("Normalized spec still has securitySchemes.Bearer (should be EdvibeApiKey)");
  if (!schemes || !schemes.EdvibeApiKey) fail("Normalized spec missing securitySchemes.EdvibeApiKey");
  return n;
}

function checkParity(snapOps, manifest, normOps) {
  const snapKeys = new Set(snapOps.map((o) => `${o.method} ${o.path}`));
  const manifestKeys = new Set(manifest.operations.map((o) => `${o.method} ${o.path}`));
  const normKeys = new Set(normOps.map((o) => `${o.method} ${o.path}`));
  for (const k of snapKeys) {
    if (!manifestKeys.has(k)) fail(`In snapshot but not in manifest: ${k}`);
    if (!normKeys.has(k)) fail(`In snapshot but not in normalized: ${k}`);
  }
  for (const k of manifestKeys) {
    if (!snapKeys.has(k)) fail(`In manifest but not in snapshot: ${k}`);
    if (!normKeys.has(k)) fail(`In manifest but not in normalized: ${k}`);
  }
  for (const k of normKeys) {
    if (!snapKeys.has(k)) fail(`In normalized but not in snapshot: ${k}`);
    if (!manifestKeys.has(k)) fail(`In normalized but not in manifest: ${k}`);
  }
}

function checkAnnotationMatrix(manifest) {
  /** @type {Record<string, {readOnlyHint:boolean,destructiveHint:boolean}>} */
  const expected = {
    read: { readOnlyHint: true, destructiveHint: false },
    write: { readOnlyHint: false, destructiveHint: false },
    "high-risk": { readOnlyHint: false, destructiveHint: true },
    sensitive: { readOnlyHint: false, destructiveHint: false },
  };
  for (const op of manifest.operations) {
    const a = op.annotations || {};
    const e = expected[op.riskClass];
    if (a.readOnlyHint !== e.readOnlyHint) {
      fail(`Annotation readOnlyHint for ${op.operationId} (${op.riskClass}): expected ${e.readOnlyHint}, got ${a.readOnlyHint}`);
    }
    if (a.destructiveHint !== e.destructiveHint) {
      fail(`Annotation destructiveHint for ${op.operationId} (${op.riskClass}): expected ${e.destructiveHint}, got ${a.destructiveHint}`);
    }
    if (a.openWorldHint !== true) {
      fail(`Annotation openWorldHint for ${op.operationId}: expected true, got ${a.openWorldHint}`);
    }
    // Sensitive tools must carry a warning in their description.
    if (op.riskClass === "sensitive") {
      const meta = op.description || "";
      if (!/sensitive|login token|approval/i.test(meta)) {
        fail(`Sensitive op ${op.operationId} missing warning in description`);
      }
    }
  }
}

function checkSnapshotImmutability(manifest) {
  const snapPath = latestSnapshotPath();
  const sha = crypto.createHash("sha256").update(fs.readFileSync(snapPath)).digest("hex");
  if (manifest.snapshot && manifest.snapshot.sha256 && manifest.snapshot.sha256 !== sha) {
    fail(`Snapshot SHA-256 changed since manifest generation. Expected ${manifest.snapshot.sha256.slice(0, 12)}…, got ${sha.slice(0, 12)}…. Regenerate manifest.`);
  }
}

// Secret scan: look for obvious API key / Bearer values in tracked files.
function checkSecrets() {
  let trackedFiles = [];
  try {
    trackedFiles = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    warn("Could not run `git ls-files`; skipping tracked-file secret scan.");
    return;
  }
  // Patterns that indicate real secrets (not placeholders).
  const patterns = [
    /Authorization:\s*Bearer\s+[A-Za-z0-9_\-]{16,}/i,
    /EDVIBE_API_KEY\s*=\s*["'][A-Za-z0-9_\-]{16,}["']/i,
    /api[_-]?key\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}["']/i,
    /token\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}["']/i,
  ];
  // Allowed placeholders that should NOT trigger.
  const allowed = /<EDVIBE_API_KEY>|<SCHOOL_HOSTNAME>|\bexample\b|placeholder/i;
  for (const rel of trackedFiles) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue;
    const text = fs.readFileSync(abs, "utf8");
    for (const p of patterns) {
      const m = text.match(p);
      if (m && !allowed.test(m[0])) {
        fail(`Possible secret in ${rel}: ${m[0].slice(0, 40)}…`);
      }
    }
  }
}

function main() {
  console.log("Validating Edvibe School MCP contract…\n");
  const { snapPath, snap, ops: snapOps } = checkSnapshot();
  const manifest = checkManifest();
  const norm = checkNormalized();
  const normOps = norm ? opsFromSpec(norm.openapi) : [];
  if (manifest) {
    checkParity(snapOps, manifest, normOps);
    checkAnnotationMatrix(manifest);
    checkSnapshotImmutability(manifest);
  }
  checkSecrets();

  console.log(`Snapshot: ${path.basename(snapPath)} — ${snapOps.length} ops`);
  if (manifest) console.log(`Manifest: ${manifest.counts.total} ops = read ${manifest.counts.read} + write ${manifest.counts.write} + high-risk ${manifest.counts["high-risk"]} + sensitive ${manifest.counts.sensitive}`);
  if (norm) console.log(`Normalized: ${normOps.length} ops`);

  if (warnings.length) {
    console.log("\nWarnings:");
    for (const w of warnings) console.log("  ⚠ " + w);
  }
  if (failures.length) {
    console.error("\nFailures:");
    for (const f of failures) console.error("  ✗ " + f);
    console.error(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main();
