// Generates manifest/operations.json — the authoritative inventory of all 78
// Edvibe School API operations.
//
// Input:
//   - openapi/snapshots/<latest>.json (upstream OpenAPI, immutable)
//   - scripts/risk-classification.js (human-authored risk map)
// Output:
//   - manifest/operations.json (do not edit by hand; regenerate via this script)
//
// The manifest is the source of truth for:
//   - stable English operationId for every operation;
//   - risk class (read | write | high-risk | sensitive);
//   - MCP tool annotations derived from risk class;
//   - parity checks against normalized spec and Postman collection.
//
// Run: node scripts/generate-manifest.js

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { RISK_BY_OPERATION, EXPECTED_COUNTS } = require("./risk-classification.cjs");
const { requiredOverridesFor } = require("./required-overrides.cjs");
const { descriptionFor } = require("./operation-meta.cjs");

const ROOT = path.resolve(__dirname, "..");
const SNAPSHOTS_DIR = path.join(ROOT, "openapi", "snapshots");
const MANIFEST_DIR = path.join(ROOT, "manifest");
const MANIFEST_PATH = path.join(MANIFEST_DIR, "operations.json");

/**
 * Stable English operationId derived from group + action.
 * Convention: "<Group><Action>" in PascalCase, group singularized where natural.
 * This map is the canonical public name; MCP tool names are derived from it.
 * @type {Record<string, string>}
 */
const OPERATION_ID = {
  "GET /api/AccessGroups/GetList": "AccessGroupsGetList",
  "GET /api/AccessGroups/GetDetails": "AccessGroupsGetDetails",
  "GET /api/AccessGroups/GetTeachers": "AccessGroupsGetTeachers",
  "GET /api/AccessGroups/GetIndividualClasses": "AccessGroupsGetIndividualClasses",
  "GET /api/AccessGroups/GetGroupClasses": "AccessGroupsGetGroupClasses",
  "POST /api/AccessGroups/Create": "AccessGroupsCreate",
  "POST /api/AccessGroups/Delete": "AccessGroupsDelete",
  "POST /api/AccessGroups/AddMembers": "AccessGroupsAddMembers",
  "POST /api/AccessGroups/RemoveMembers": "AccessGroupsRemoveMembers",
  "POST /api/Books/GetBooksPlatform": "BooksGetBooksPlatform",
  "POST /api/Books/GetBooksSchool": "BooksGetBooksSchool",
  "POST /api/Books/GetBook": "BooksGetBook",
  "POST /api/Books/PinLessonToClass": "BooksPinLessonToClass",
  "POST /api/Classes/GetStatistics": "ClassesGetStatistics",
  "GET /api/GroupClasses/GetList": "GroupClassesGetList",
  "GET /api/GroupClasses/GetDetail": "GroupClassesGetDetail",
  "POST /api/GroupClasses/Create": "GroupClassesCreate",
  "POST /api/GroupClasses/Update": "GroupClassesUpdate",
  "POST /api/GroupClasses/ChangeTeacher": "GroupClassesChangeTeacher",
  "POST /api/GroupClasses/Delete": "GroupClassesDelete",
  "GET /api/GroupClassPupils/GetList": "GroupClassPupilsGetList",
  "POST /api/GroupClassPupils/Add": "GroupClassPupilsAdd",
  "POST /api/GroupClassPupils/Delete": "GroupClassPupilsDelete",
  "GET /api/IndividualClasses/GetList": "IndividualClassesGetList",
  "GET /api/IndividualClasses/GetDetail": "IndividualClassesGetDetail",
  "POST /api/IndividualClasses/ChangeTeacher": "IndividualClassesChangeTeacher",
  "POST /api/IndividualClasses/Create": "IndividualClassesCreate",
  "POST /api/IndividualClasses/Update": "IndividualClassesUpdate",
  "POST /api/IndividualClasses/Delete": "IndividualClassesDelete",
  "GET /api/LessonPackages/GetList": "LessonPackagesGetList",
  "POST /api/LessonPackages/SetPackage": "LessonPackagesSetPackage",
  "POST /api/LessonPackages/UpdatePackagePeriod": "LessonPackagesUpdatePackagePeriod",
  "POST /api/LessonPackages/WriteOffLessons": "LessonPackagesWriteOffLessons",
  "GET /api/LessonTariffs/GetList": "LessonTariffsGetList",
  "GET /api/LessonTariffs/GetTariffForDurationId": "LessonTariffsGetTariffForDurationId",
  "POST /api/LessonTariffs/Create": "LessonTariffsCreate",
  "POST /api/LessonTariffs/Delete": "LessonTariffsDelete",
  "POST /api/LessonTariffs/AddTariffDuration": "LessonTariffsAddTariffDuration",
  "GET /api/LessonTariffs/GetTariffDurationList": "LessonTariffsGetTariffDurationList",
  "POST /api/LessonTariffs/DeleteTariffDuration": "LessonTariffsDeleteTariffDuration",
  "POST /api/LessonTariffs/DeleteLessonPackage": "LessonTariffsDeleteLessonPackage",
  "POST /api/Marathon/ChangeActivationMarathonPupil": "MarathonChangeActivationMarathonPupil",
  "GET /api/Marathon/GetMarathonList": "MarathonGetMarathonList",
  "GET /api/Marathon/GetMarathonStudents": "MarathonGetMarathonStudents",
  "GET /api/Marathon/AddMarathonNewStudents": "MarathonAddMarathonNewStudents",
  "POST /api/Marathon/CreateModerator": "MarathonCreateModerator",
  "POST /api/Marathon/DeleteModerator": "MarathonDeleteModerator",
  "POST /api/Marathon/SetPupilsForModerator": "MarathonSetPupilsForModerator",
  "POST /api/Marathon/SetModeratorsForPupil": "MarathonSetModeratorsForPupil",
  "POST /api/Marathon/UnsetPupilsForModerator": "MarathonUnsetPupilsForModerator",
  "POST /api/Marathon/UnsetModeratorsForPupil": "MarathonUnsetModeratorsForPupil",
  "GET /api/Marathon/GetModerators": "MarathonGetModerators",
  "GET /api/Pupils/GetList": "PupilsGetList",
  "GET /api/Pupils/GetCursorList": "PupilsGetCursorList",
  "GET /api/Pupils/GetDetail": "PupilsGetDetail",
  "POST /api/Pupils/Create": "PupilsCreate",
  "POST /api/Pupils/Update": "PupilsUpdate",
  "POST /api/Pupils/Delete": "PupilsDelete",
  "GET /api/PupilTag/GetList": "PupilTagGetList",
  "POST /api/PupilTag/Create": "PupilTagCreate",
  "POST /api/PupilTag/Delete": "PupilTagDelete",
  "POST /api/Schedule/GetSchoolSchedule": "ScheduleGetSchoolSchedule",
  "POST /api/Schedule/GetPupilSchedule": "ScheduleGetPupilSchedule",
  "GET /api/Schedule/GetTeacherWeekWorkTime": "ScheduleGetTeacherWeekWorkTime",
  "GET /api/Schedule/GetSchoolWeekWorkTime": "ScheduleGetSchoolWeekWorkTime",
  "GET /api/Schedule/GetPackageForIndividualLesson": "ScheduleGetPackageForIndividualLesson",
  "GET /api/Schedule/GetPackageForGroupLesson": "ScheduleGetPackageForGroupLesson",
  "POST /api/Schedule/GetTeacherSchedule": "ScheduleGetTeacherSchedule",
  "POST /api/Schedule/CreateLesson": "ScheduleCreateLesson",
  "POST /api/Schedule/DeleteLesson": "ScheduleDeleteLesson",
  "GET /api/Teachers/GetList": "TeachersGetList",
  "GET /api/Teachers/GetDetail": "TeachersGetDetail",
  "POST /api/Teachers/Create": "TeachersCreate",
  "POST /api/Teachers/Update": "TeachersUpdate",
  "POST /api/Teachers/Delete": "TeachersDelete",
  "POST /api/UserAuth/LoginPupil": "UserAuthLoginPupil",
  "POST /api/UserAuth/LoginTeacher": "UserAuthLoginTeacher",
  "POST /api/UserAuth/CheckAuthToken": "UserAuthCheckAuthToken",
};

/**
 * Build MCP ToolAnnotations from a risk class.
 * Annotations are hints, not a security boundary. Client approvals remain mandatory.
 * @param {import("./risk-classification").RiskClass} riskClass
 * @returns {Record<string, boolean>}
 */
function annotationsFor(riskClass) {
  // All operations call an external upstream -> openWorldHint=true.
  // idempotentHint stays false by default; set per operation only after verified behavior.
  switch (riskClass) {
    case "read":
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    case "write":
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    case "high-risk":
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
    case "sensitive":
      // Sensitive login tools are non-destructive but require explicit per-tool approval
      // and a warning in the description.
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    default:
      throw new Error(`Unknown risk class: ${riskClass}`);
  }
}

/** Find the latest snapshot file in openapi/snapshots. */
function latestSnapshot() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    throw new Error(`Snapshots directory not found: ${SNAPSHOTS_DIR}`);
  }
  const files = fs
    .readdirSync(SNAPSHOTS_DIR)
    .filter((f) => /^swagger-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (files.length === 0) {
    throw new Error("No snapshot file matching swagger-YYYY-MM-DD.json found in openapi/snapshots");
  }
  return path.join(SNAPSHOTS_DIR, files[files.length - 1]);
}

function main() {
  const snapshotPath = latestSnapshot();
  const snapshotRaw = fs.readFileSync(snapshotPath, "utf8");
  const snapshot = JSON.parse(snapshotRaw);
  const sha256 = crypto.createHash("sha256").update(snapshotRaw).digest("hex");

  const paths = snapshot.paths || {};
  /** @type {Array<any>} */
  const operations = [];
  /** @type {Array<string>} */
  const errors = [];

  for (const [pathStr, methods] of Object.entries(paths)) {
    for (const method of Object.keys(methods)) {
      if (!["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method)) continue;
      const op = methods[method];
      const key = `${method.toUpperCase()} ${pathStr}`;
      const riskClass = RISK_BY_OPERATION[key];
      const operationId = OPERATION_ID[key];
      if (!riskClass) errors.push(`Missing risk classification for: ${key}`);
      if (!operationId) errors.push(`Missing operationId for: ${key}`);

      const groupMatch = pathStr.match(/^\/api\/([^/]+)/);
      const group = groupMatch ? groupMatch[1] : "Unknown";

      const params = (op.parameters || []).map((p) => ({
        name: p.name,
        in: p.in,
        required: !!p.required,
        schema: p.schema || undefined,
        dotted: p.name.includes("."),
      }));

      const bodyContent = op.requestBody && op.requestBody.content;
      const jsonBody =
        bodyContent && (bodyContent["application/json"] || bodyContent["text/json"]);
      const hasBody = !!jsonBody;
      const bodyRequired = !!(op.requestBody && op.requestBody.required);
      // Empirically verified required body fields (see scripts/required-overrides.cjs
      // and CONTEXT.md → "Расхождения upstream OpenAPI vs live-поведение").
      // Empty for operations with no recorded overrides.
      const bodyRequiredFields = requiredOverridesFor(operationId);

      operations.push({
        operationId,
        method: method.toUpperCase(),
        path: pathStr,
        group,
        riskClass,
        annotations: annotationsFor(riskClass),
        tags: op.tags || [group],
        summary: op.summary || "",
        description: descriptionFor(operationId),
        hasBody,
        bodyRequired,
        bodyRequiredFields,
        parameters: params,
      });
    }
  }

  // Sort by group then path then method for stable output.
  operations.sort(
    (a, b) =>
      a.group.localeCompare(b.group) ||
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method)
  );

  // Control sums.
  const counts = { total: operations.length, read: 0, write: 0, "high-risk": 0, sensitive: 0 };
  for (const op of operations) counts[op.riskClass] += 1;

  // operationId uniqueness.
  const ids = operations.map((o) => o.operationId);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) errors.push(`Duplicate operationId: ${dupes.join(", ")}`);

  // method/path uniqueness.
  const keys = operations.map((o) => `${o.method} ${o.path}`);
  const dupeKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupeKeys.length) errors.push(`Duplicate method/path: ${dupeKeys.join(", ")}`);

  // Coverage of risk map vs snapshot.
  const snapshotKeys = new Set(keys);
  for (const mapKey of Object.keys(RISK_BY_OPERATION)) {
    if (!snapshotKeys.has(mapKey)) {
      errors.push(`Risk map references operation absent in snapshot: ${mapKey}`);
    }
  }
  for (const k of snapshotKeys) {
    if (!RISK_BY_OPERATION[k]) errors.push(`Snapshot operation missing from risk map: ${k}`);
  }

  // Count checks.
  for (const [k, expected] of Object.entries(EXPECTED_COUNTS)) {
    if (counts[k] !== expected) {
      errors.push(`Count mismatch for ${k}: expected ${expected}, got ${counts[k]}`);
    }
  }

  if (errors.length) {
    console.error("Manifest generation failed with errors:");
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }

  const manifest = {
    snapshot: {
      file: path.basename(snapshotPath),
      sha256,
      openapi: snapshot.openapi,
      info: snapshot.info,
      servers: snapshot.servers,
    },
    expectedCounts: EXPECTED_COUNTS,
    counts,
    operations,
  };

  if (!fs.existsSync(MANIFEST_DIR)) fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  console.log("Manifest written:", path.relative(ROOT, MANIFEST_PATH));
  console.log("Snapshot:", manifest.snapshot.file, `(${sha256.slice(0, 12)}…)`);
  console.log("Operations:", counts.total, `= read ${counts.read} + write ${counts.write} + high-risk ${counts["high-risk"]} + sensitive ${counts.sensitive}`);
}

main();
