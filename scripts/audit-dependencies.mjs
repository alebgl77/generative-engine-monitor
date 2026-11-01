import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ADVISORY = "https://github.com/advisories/GHSA-g3hv-75wg-m249";
const EXPIRY = "2026-11-15T23:00:00Z";
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const ROOT = fileURLToPath(new URL("../", import.meta.url));

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keysAre(value, keys) {
  return record(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function strings(value, allowEmpty = false) {
  return Array.isArray(value) && (allowEmpty || value.length > 0) &&
    value.every((item) => typeof item === "string" && item.length > 0) &&
    new Set(value).size === value.length;
}

function nodePath(value) {
  return typeof value === "string" && value.startsWith("node_modules/") &&
    !value.includes("\\") && !value.split("/").some((part) => !part || part === "." || part === "..");
}

function fingerprint(finding) {
  return {
    nodes: [...finding.nodes].sort(),
    via: finding.via.map((item) => typeof item === "string" ? `package:${item}` : `advisory:${item.url}`).sort(),
  };
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalOrder(left, right) {
  const a = JSON.stringify(left);
  const b = JSON.stringify(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function validateReport(report) {
  requireThat(keysAre(report, ["auditReportVersion", "vulnerabilities", "metadata"]) &&
    report.auditReportVersion === 2 && record(report.vulnerabilities), "Unknown npm audit report schema.");
  requireThat(keysAre(report.metadata, ["vulnerabilities", "dependencies"]) &&
    keysAre(report.metadata.vulnerabilities, [...SEVERITIES, "total"]) &&
    keysAre(report.metadata.dependencies, ["prod", "dev", "optional", "peer", "peerOptional", "total"]),
  "Unknown npm audit metadata schema.");
  for (const counts of Object.values(report.metadata)) {
    requireThat(Object.values(counts).every((value) => Number.isSafeInteger(value) && value >= 0),
      "Invalid npm audit counts.");
  }
  const findings = new Map(Object.entries(report.vulnerabilities));
  requireThat(findings.size <= 256, "Audit graph exceeds the reviewed bound.");
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const [name, finding] of findings) {
    requireThat(keysAre(finding, ["name", "severity", "isDirect", "via", "effects", "range", "nodes", "fixAvailable"]) &&
      finding.name === name && SEVERITIES.includes(finding.severity) && typeof finding.isDirect === "boolean" &&
      typeof finding.range === "string" && strings(finding.nodes) && finding.nodes.every(nodePath) &&
      strings(finding.effects, true) && Array.isArray(finding.via) && finding.via.length > 0 && finding.via.length <= 256,
    `Unknown finding schema: ${name}.`);
    const fix = finding.fixAvailable;
    requireThat(typeof fix === "boolean" ||
      (keysAre(fix, ["name", "version", "isSemVerMajor"]) && typeof fix.name === "string" &&
        typeof fix.version === "string" && typeof fix.isSemVerMajor === "boolean"), `Invalid fix metadata: ${name}.`);
    for (const via of finding.via) {
      if (typeof via === "string") {
        requireThat(findings.has(via), `Missing audit reference: ${via}.`);
      } else {
        requireThat(keysAre(via, ["source", "name", "dependency", "title", "url", "severity", "cwe", "cvss", "range"]) &&
          Number.isSafeInteger(via.source) && via.source > 0 && typeof via.name === "string" &&
          typeof via.dependency === "string" && typeof via.title === "string" && typeof via.url === "string" &&
          SEVERITIES.includes(via.severity) && strings(via.cwe, true) && typeof via.range === "string" &&
          keysAre(via.cvss, ["score", "vectorString"]) && Number.isFinite(via.cvss.score) &&
          via.cvss.score >= 0 && via.cvss.score <= 10 &&
          (via.cvss.vectorString === null || typeof via.cvss.vectorString === "string"),
        `Unknown advisory schema: ${name}.`);
        requireThat(SEVERITIES.indexOf(via.severity) <= SEVERITIES.indexOf(finding.severity),
          `Advisory severity is understated by its finding: ${name}.`);
      }
    }
    counts[finding.severity] += 1;
  }
  requireThat(SEVERITIES.every((severity) => counts[severity] === report.metadata.vulnerabilities[severity]) &&
    findings.size === report.metadata.vulnerabilities.total, "Inconsistent npm audit counts.");
  return findings;
}

// Tarjan's algorithm is bounded by validateReport, then only the condensed DAG
// is evaluated. Encountering a previously visited node never grants a waiver.
function componentsOf(findings) {
  let nextIndex = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  function visit(name) {
    index.set(name, nextIndex);
    low.set(name, nextIndex++);
    stack.push(name);
    onStack.add(name);
    for (const via of findings.get(name).via) {
      if (typeof via !== "string") continue;
      if (!index.has(via)) {
        visit(via);
        low.set(name, Math.min(low.get(name), low.get(via)));
      } else if (onStack.has(via)) {
        low.set(name, Math.min(low.get(name), index.get(via)));
      }
    }
    if (low.get(name) === index.get(name)) {
      const members = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        members.push(member);
      } while (member !== name);
      components.push(members.sort());
    }
  }
  for (const name of findings.keys()) if (!index.has(name)) visit(name);
  return components;
}

function validateExceptionGraph(findings, policy) {
  const components = componentsOf(findings);
  const membership = new Map(components.flatMap((members, id) => members.map((name) => [name, id])));
  const cycles = [];
  const outgoing = components.map(() => new Set());
  const localLeaf = components.map(() => false);
  for (const [id, members] of components.entries()) {
    const internalEdges = [];
    for (const name of members) {
      for (const via of findings.get(name).via) {
        if (typeof via === "string") {
          const destination = membership.get(via);
          if (destination === id) internalEdges.push([name, via]);
          else outgoing[id].add(destination);
        } else {
          requireThat(name === "minimatch" && via.url === ADVISORY && via.name === "minimatch" && via.dependency === "minimatch" &&
            via.severity === "moderate", `Unexcepted advisory: ${via.url}.`);
          localLeaf[id] = true;
        }
      }
    }
    if (members.length > 1 || internalEdges.length > 0) {
      cycles.push({ members, edges: internalEdges.sort(canonicalOrder) });
    }
  }
  const cycleOrder = (a, b) => canonicalOrder(a.members, b.members);
  requireThat(same(cycles.sort(cycleOrder), [...policy.allowedCycles].sort(cycleOrder)),
    "Unreviewed cyclic component or internal edge.");
  const productive = new Map();
  function reachesAllowedLeaf(id) {
    if (productive.has(id)) return productive.get(id);
    const children = [...outgoing[id]].map(reachesAllowedLeaf);
    const valid = children.every(Boolean) && (localLeaf[id] || children.some(Boolean));
    productive.set(id, valid);
    return valid;
  }
  requireThat(components.every((_, id) => reachesAllowedLeaf(id)), "Audit component has no productive allowed advisory leaf.");
  requireThat(same([...findings.keys()].sort(), Object.keys(policy.expectedFindings).sort()), "Audit finding graph changed.");
  for (const [name, finding] of findings) {
    requireThat(same(fingerprint(finding), policy.expectedFindings[name]), `Audit paths or edges changed: ${name}.`);
  }
}

function validatePolicy(policy, lockBytes, findings, now) {
  requireThat(keysAre(policy, ["schemaVersion", "advisoryUrl", "expiresAt", "lockSha256", "copies", "expectedFindings", "allowedCycles"]) &&
    policy.schemaVersion === 1 && policy.advisoryUrl === ADVISORY && policy.expiresAt === EXPIRY &&
    typeof policy.lockSha256 === "string" && /^[a-f0-9]{64}$/.test(policy.lockSha256) &&
    Array.isArray(policy.copies) && policy.copies.length === 2 && record(policy.expectedFindings) &&
    Array.isArray(policy.allowedCycles), "Invalid or expanded exception policy.");
  requireThat(Number.isSafeInteger(now) && now > 0 && now < Date.parse(EXPIRY), "Temporary audit exception expired or clock invalid.");
  requireThat(createHash("sha256").update(lockBytes).digest("hex") === policy.lockSha256, "Package lock changed; exception requires review.");
  const lock = JSON.parse(lockBytes.toString("utf8"));
  requireThat(record(lock) && lock.lockfileVersion === 3 && record(lock.packages), "Unknown lockfile schema.");
  const copyPaths = [];
  for (const copy of policy.copies) {
    requireThat(keysAre(copy, ["path", "version", "integrity", "dev"]) && nodePath(copy.path) &&
      ["3.1.5", "10.2.6"].includes(copy.version) && typeof copy.integrity === "string" && copy.dev === true,
    "Invalid reviewed minimatch copy.");
    const installed = lock.packages[copy.path];
    requireThat(record(installed) && installed.version === copy.version && installed.integrity === copy.integrity &&
      installed.dev === true, `Minimatch copy changed or is not development-only: ${copy.path}.`);
    copyPaths.push(copy.path);
  }
  requireThat(new Set(copyPaths).size === 2 && findings.has("minimatch") &&
    same([...copyPaths].sort(), [...findings.get("minimatch").nodes].sort()), "Minimatch copies or paths changed.");
  for (const finding of findings.values()) {
    requireThat(finding.severity === "moderate", "Exception cannot admit another severity.");
    for (const path of finding.nodes) {
      requireThat(record(lock.packages[path]) && lock.packages[path].dev === true,
        `Finding is not development-only: ${path}.`);
    }
  }
  for (const [name, expected] of Object.entries(policy.expectedFindings)) {
    requireThat(keysAre(expected, ["nodes", "via"]) && strings(expected.nodes) && expected.nodes.every(nodePath) &&
      strings(expected.via) && same(expected.nodes, [...expected.nodes].sort()) && same(expected.via, [...expected.via].sort()),
    `Invalid expected graph entry: ${name}.`);
  }
  for (const cycle of policy.allowedCycles) {
    requireThat(keysAre(cycle, ["members", "edges"]) && strings(cycle.members) &&
      same(cycle.members, [...cycle.members].sort()) && cycle.members.every((name) => findings.has(name)) &&
      Array.isArray(cycle.edges) && cycle.edges.length > 0 && cycle.edges.every((edge) =>
        Array.isArray(edge) && edge.length === 2 && edge.every((name) => cycle.members.includes(name))) &&
      new Set(cycle.edges.map((edge) => JSON.stringify(edge))).size === cycle.edges.length,
    "Invalid reviewed cycle.");
  }
  validateExceptionGraph(findings, policy);
}

export function evaluateAuditExecution(execution, lockBytes, policy, now = Date.now()) {
  let validatedReport;
  try {
    requireThat(record(execution) && !execution.error && execution.signal === null &&
      [0, 1].includes(execution.status) && typeof execution.stdout === "string", "npm audit could not be completed.");
    const report = JSON.parse(execution.stdout);
    const findings = validateReport(report);
    validatedReport = report;
    const blocking = [...findings.values()].filter((finding) => ["moderate", "high", "critical"].includes(finding.severity));
    requireThat(execution.status === (blocking.length ? 1 : 0), "npm audit status contradicts its report.");
    if (blocking.length === 0) {
      return { ok: true, exceptionUsed: false, reason: "Ordinary moderate-level audit passed; exception not used.", report };
    }
    validatePolicy(policy, lockBytes, findings, now);
    return {
      ok: true,
      exceptionUsed: true,
      reason: `TEMPORARY EXCEPTION: ${findings.size} moderate findings remain visible; only ${ADVISORY}, expires ${EXPIRY}.`,
      report,
    };
  } catch (error) {
    return {
      ok: false,
      exceptionUsed: false,
      reason: error instanceof Error ? error.message : "Audit validation failed.",
      ...(validatedReport ? { report: validatedReport } : {}),
    };
  }
}

export function runAuditCli() {
  try {
    requireThat(process.argv.length === 2, "This audit command accepts no arguments or clock overrides.");
    const npmCli = process.env.npm_execpath;
    requireThat(typeof npmCli === "string" && isAbsolute(npmCli) && basename(npmCli) === "npm-cli.js",
      "Run this command through npm run audit:security.");
    const execution = spawnSync(process.execPath, [npmCli, "audit", "--json", "--audit-level=moderate", "--include=dev"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
      shell: false,
    });
    const lockBytes = readFileSync(new URL("../package-lock.json", import.meta.url));
    let policy = null;
    try {
      policy = JSON.parse(readFileSync(new URL("../security/minimatch-audit-exception.json", import.meta.url), "utf8"));
    } catch {
      // A clean ordinary audit does not need an exception policy at all.
    }
    const result = evaluateAuditExecution(execution, lockBytes, policy, Date.now());
    if (result.report) console.log(execution.stdout.trimEnd());
    console[result.ok ? "log" : "error"](result.reason);
    return result.ok ? 0 : 1;
  } catch {
    console.error("Audit gate could not be completed; no exception applied.");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runAuditCli();
}
