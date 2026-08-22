// Generates a Postman Collection v2.1.0 JSON from the manifest.
//
// Output: postman/edvibe-school-api.postman_collection.json
//
// Structure:
//   - 14 folders (one per API group), sorted alphabetically.
//   - 78 requests (one per operation), sorted within each folder.
//   - Collection-level variables: schoolDomain, edvibeApiKey (placeholders only).
//   - Each request uses {{schoolDomain}} in the URL and {{edvibeApiKey}} in the
//     Authorization header. No real keys or domains.
//   - Each request has an English description with the risk warning.
//   - Each request has a test script that checks BaseResponse.isSuccess.
//   - Collection and folder descriptions mark the project as experimental/unofficial.
//
// This file is a generated artifact. To change descriptions or risk warnings,
// edit scripts/operation-meta.js and rerun this script.
//
// Run: node scripts/generate-postman-collection.js

"use strict";

const fs = require("fs");
const path = require("path");
const { OPERATION_META, descriptionFor } = require("./operation-meta.cjs");
const { RISK_BY_OPERATION } = require("./risk-classification.cjs");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "manifest", "operations.json");
const OUT_DIR = path.join(ROOT, "postman");
const OUT_PATH = path.join(OUT_DIR, "edvibe-school-api.postman_collection.json");

const SCHEMA = "https://schema.postman.com/json/collection/v2.1.0/collection.json";

/** BaseResponse test script added to every request. */
const BASE_RESPONSE_TEST = [
  "// BaseResponse contract test",
  "pm.test(\"Response status is 200\", function () {",
  "    pm.response.to.have.status(200);",
  "});",
  "",
  "pm.test(\"BaseResponse.isSuccess is true\", function () {",
  "    let body;",
  "    try { body = pm.response.json(); } catch (e) { throw new Error(\"Response is not valid JSON: \" + e.message); }",
  "    pm.expect(body).to.have.property(\"isSuccess\");",
  "    if (body.isSuccess === false) {",
  "        const msg = body.errorMessage || \"(no errorMessage)\";",
  "        throw new Error(\"BaseResponse.isSuccess=false: \" + msg);",
  "    }",
  "    pm.expect(body.isSuccess).to.be.true;",
  "});",
  "",
  "pm.test(\"errorStackTrace is not exposed\", function () {",
  "    let body;",
  "    try { body = pm.response.json(); } catch (e) { return; }",
  "    if (body && body.errorStackTrace) {",
  "        throw new Error(\"errorStackTrace must not be returned to the client\");",
  "    }",
  "});",
];

/** Risk badge for folder/request descriptions. */
function riskBadge(riskClass) {
  switch (riskClass) {
    case "read": return "READ";
    case "write": return "WRITE";
    case "high-risk": return "HIGH-RISK (destructive)";
    case "sensitive": return "SENSITIVE (login token)";
    default: return riskClass.toUpperCase();
  }
}

/** Build a Postman request item from a manifest operation. */
function buildRequest(op) {
  const desc = descriptionFor(op.operationId);
  const badge = riskBadge(op.riskClass);
  const fullDesc = `${desc}\n\n**Risk class:** ${badge}\n**operationId:** ${op.operationId}\n\n*Experimental/unofficial — not an official Edvibe product.*`;

  // URL: https://{{schoolDomain}}/school-api{path}
  const urlPath = op.path; // e.g. /api/AccessGroups/GetList
  const url = {
    raw: `https://{{schoolDomain}}/school-api${urlPath}`,
    protocol: "https",
    host: ["{{schoolDomain}}"],
    path: ["school-api", ...urlPath.split("/").filter(Boolean)],
  };

  // Add query parameters
  if (op.parameters && op.parameters.length > 0) {
    url.query = op.parameters.map((p) => ({
      key: p.name,
      value: "",
      disabled: !p.required,
      description: p.schema ? `${p.schema.type || ""} ${p.required ? "(required)" : "(optional)"}`.trim() : "",
    }));
  }

  // Headers
  const headers = [
    {
      key: "Authorization",
      value: "{{edvibeApiKey}}",
      type: "text",
      description: "Edvibe School API key. Raw value, no Bearer prefix. Use a Postman Local Vault secret — never share or commit.",
    },
  ];

  // Request body for POST/PUT/PATCH with body
  let body = undefined;
  if (op.hasBody) {
    body = {
      mode: "raw",
      raw: "{\n  \n}",
      options: {
        raw: {
          language: "json",
        },
      },
    };
  }

  return {
    name: op.operationId,
    request: {
      method: op.method,
      header: headers,
      body,
      url,
      description: fullDesc,
    },
    event: [
      {
        listen: "test",
        script: {
          type: "text/javascript",
          exec: BASE_RESPONSE_TEST,
        },
      },
    ],
  };
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const ops = manifest.operations;

  // Group operations by group tag
  /** @type {Record<string, Array<any>>} */
  const byGroup = {};
  for (const op of ops) {
    if (!byGroup[op.group]) byGroup[op.group] = [];
    byGroup[op.group].push(op);
  }

  // Build folders sorted alphabetically
  const folders = Object.keys(byGroup)
    .sort()
    .map((group) => {
      const groupOps = byGroup[group].sort((a, b) => a.operationId.localeCompare(b.operationId));
      const readCount = groupOps.filter((o) => o.riskClass === "read").length;
      const writeCount = groupOps.filter((o) => o.riskClass === "write").length;
      const highRiskCount = groupOps.filter((o) => o.riskClass === "high-risk").length;
      const sensitiveCount = groupOps.filter((o) => o.riskClass === "sensitive").length;
      const summary = `${groupOps.length} operations: ${readCount} read, ${writeCount} write, ${highRiskCount} high-risk, ${sensitiveCount} sensitive`;
      return {
        name: group,
        description: `${group} API group. ${summary}.\n\n*Experimental/unofficial — not an official Edvibe product.*`,
        item: groupOps.map(buildRequest),
      };
    });

  const collection = {
    info: {
      name: "Edvibe School API",
      _postman_id: "", // let Postman assign
      description: "Experimental/unofficial collection for the Edvibe School API. Generated from the normalized OpenAPI spec and manifest. All 78 operations across 14 groups. Use with Postman Local Vault secrets only — never share or commit real API keys or school domains. Not an official Edvibe product.",
      schema: SCHEMA,
    },
    variable: [
      {
        key: "schoolDomain",
        value: "<SCHOOL_HOSTNAME>",
        type: "string",
        description: "Hostname of the school's Edvibe or White Label domain. HTTPS only, port 443, no scheme/path/port. Replace with your test school hostname.",
      },
      {
        key: "edvibeApiKey",
        value: "<EDVIBE_API_KEY>",
        type: "secret",
        description: "Edvibe School API key. Store in Postman Local Vault — never in shared/current values, Git, or docs. Raw value, no Bearer prefix.",
      },
    ],
    item: folders,
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(collection, null, 2) + "\n");

  // Verify counts
  let totalReqs = 0;
  const folderCounts = {};
  for (const f of folders) {
    folderCounts[f.name] = f.item.length;
    totalReqs += f.item.length;
  }
  console.log("Postman collection written:", path.relative(ROOT, OUT_PATH));
  console.log("Folders:", folders.length);
  console.log("Total requests:", totalReqs);
  console.log("Folder breakdown:", JSON.stringify(folderCounts));
  if (totalReqs !== 78) {
    console.error(`ERROR: expected 78 requests, got ${totalReqs}`);
    process.exit(1);
  }
}

main();
