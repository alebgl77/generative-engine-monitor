import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateAuditExecution } from "../scripts/audit-dependencies.mjs";

type Advisory = {
  source: number;
  name: string;
  dependency: string;
  title: string;
  url: string;
  severity: string;
  cwe: string[];
  cvss: { score: number; vectorString: string | null };
  range: string;
};
type Finding = {
  name: string;
  severity: string;
  isDirect: boolean;
  via: (string | Advisory)[];
  effects: string[];
  range: string;
  nodes: string[];
  fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
};
type Report = {
  auditReportVersion: number;
  vulnerabilities: Record<string, Finding>;
  metadata: {
    vulnerabilities: Record<string, number>;
    dependencies: Record<string, number>;
  };
};

const originalReport = JSON.parse(readFileSync(new URL("./fixtures/npm-audit-minimatch.json", import.meta.url), "utf8")) as Report;
const originalPolicy = JSON.parse(readFileSync(new URL("../security/minimatch-audit-exception.json", import.meta.url), "utf8"));
const originalLock = readFileSync(new URL("../package-lock.json", import.meta.url));
const now = Date.parse("2026-11-02T00:00:00Z");
const expiry = Date.parse("2026-11-15T23:00:00Z");

function fresh() {
  return { report: structuredClone(originalReport), policy: structuredClone(originalPolicy), lock: Buffer.from(originalLock) };
}

function recount(report: Report) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } as Record<string, number>;
  for (const finding of Object.values(report.vulnerabilities)) {
    counts[finding.severity] += 1;
    counts.total += 1;
  }
  report.metadata.vulnerabilities = counts;
}

function run(report: Report, policy = originalPolicy, lock = originalLock, at = now) {
  const blocking = Object.values(report.vulnerabilities).some((finding) => ["moderate", "high", "critical"].includes(finding.severity));
  return evaluateAuditExecution({ status: blocking ? 1 : 0, signal: null, stdout: JSON.stringify(report) }, lock, policy, at);
}

function changedLock(path: string, field: string, value: unknown) {
  const fixture = fresh();
  const parsed = JSON.parse(fixture.lock.toString("utf8"));
  parsed.packages[path][field] = value;
  fixture.lock = Buffer.from(JSON.stringify(parsed));
  // Updating the hash alone must not override the independent path/version/dev guards.
  fixture.policy.lockSha256 = createHash("sha256").update(fixture.lock).digest("hex");
  return fixture;
}

describe("temporary dependency audit exception", () => {
  it("admits the real 16-finding report, including its exact productive peer cycle", () => {
    const result = run(originalReport);
    expect(result.ok).toBe(true);
    expect(result.exceptionUsed).toBe(true);
    expect(result.report).toEqual(originalReport);
    expect(result.reason).toContain("16 moderate findings remain visible");
    expect(result.reason).toContain("2026-11-15T23:00:00Z");
  });

  it("remains valid immediately before expiration, and fails at the fixed boundary", () => {
    expect(run(originalReport, originalPolicy, originalLock, expiry - 1).ok).toBe(true);
    expect(run(originalReport, originalPolicy, originalLock, expiry).reason).toMatch(/expired/);
  });

  it.each([NaN, Infinity, -1])("rejects invalid clock %s", (at) => {
    expect(run(originalReport, originalPolicy, originalLock, at).ok).toBe(false);
  });

  it("rejects a changed lock, even if the only byte change is whitespace", () => {
    expect(run(originalReport, originalPolicy, Buffer.concat([originalLock, Buffer.from("\n")])).reason).toMatch(/lock changed/);
  });

  it.each(["3.1.6", "11.0.3"])("rejects minimatch version %s even with a newly calculated lock hash", (version) => {
    const fixture = changedLock("node_modules/minimatch", "version", version);
    expect(run(fixture.report, fixture.policy, fixture.lock).ok).toBe(false);
  });

  it("rejects changed minimatch integrity independently of the whole-lock hash", () => {
    const fixture = changedLock("node_modules/minimatch", "integrity", "sha512-other");
    expect(run(fixture.report, fixture.policy, fixture.lock).ok).toBe(false);
  });

  it.each(["node_modules/minimatch", "node_modules/eslint"])("rejects a runtime finding at %s", (path) => {
    const fixture = changedLock(path, "dev", false);
    expect(run(fixture.report, fixture.policy, fixture.lock).reason).toMatch(/development-only/);
  });

  it("rejects a new minimatch path", () => {
    const { report } = fresh();
    report.vulnerabilities.minimatch.nodes.push("node_modules/new-parent/node_modules/minimatch");
    expect(run(report).ok).toBe(false);
  });

  it("rejects a changed parent finding path", () => {
    const { report } = fresh();
    report.vulnerabilities.eslint.nodes.push("node_modules/vitest");
    expect(run(report).reason).toMatch(/paths or edges changed/);
  });

  it("rejects an additional outgoing graph edge", () => {
    const { report } = fresh();
    report.vulnerabilities.eslint.via.push("@typescript-eslint/typescript-estree");
    expect(run(report).reason).toMatch(/paths or edges changed/);
  });

  it("rejects a missing audit reference", () => {
    const { report } = fresh();
    report.vulnerabilities.eslint.via.push("missing-package");
    expect(run(report).reason).toMatch(/Missing audit reference/);
  });

  it("rejects a new cyclic component", () => {
    const { report } = fresh();
    report.vulnerabilities["@eslint/config-array"].via.push("@eslint/config-array");
    expect(run(report).reason).toMatch(/cyclic component/);
  });

  it("rejects a new internal edge in the otherwise reviewed cyclic component", () => {
    const { report } = fresh();
    report.vulnerabilities.eslint.via.push("eslint");
    expect(run(report).reason).toMatch(/internal edge/);
  });

  it("rejects the exact peer cycle if it no longer reaches a true advisory leaf", () => {
    const { report } = fresh();
    report.vulnerabilities.eslint.via = ["@eslint-community/eslint-utils"];
    expect(run(report).reason).toMatch(/no productive allowed advisory leaf/);
  });

  it("does not admit another advisory reachable through the known cycle", () => {
    const { report } = fresh();
    const other = structuredClone(report.vulnerabilities.minimatch.via[0]) as Advisory;
    other.url = "https://github.com/advisories/GHSA-other-advisory";
    report.vulnerabilities.minimatch.via.push(other);
    const result = run(report);
    expect(result.ok).toBe(false);
    expect(result.report).toEqual(report);
    expect(result.reason).toMatch(/Unexcepted advisory/);
  });

  it("rejects another moderate package rather than filtering by minimatch's name", () => {
    const { report } = fresh();
    const leaf = structuredClone(report.vulnerabilities.minimatch.via[0]) as Advisory;
    leaf.name = "vitest";
    leaf.dependency = "vitest";
    leaf.url = "https://github.com/advisories/GHSA-other-advisory";
    report.vulnerabilities.vitest = {
      ...structuredClone(report.vulnerabilities.minimatch),
      name: "vitest",
      nodes: ["node_modules/vitest"],
      via: [leaf],
    };
    recount(report);
    expect(run(report).ok).toBe(false);
  });

  it.each(["high", "critical"])("rejects %s severity even for the named advisory", (severity) => {
    const { report } = fresh();
    report.vulnerabilities.minimatch.severity = severity;
    (report.vulnerabilities.minimatch.via[0] as Advisory).severity = severity;
    recount(report);
    expect(run(report).ok).toBe(false);
  });

  it("rejects a new low-severity advisory when an exception is needed", () => {
    const { report } = fresh();
    report.vulnerabilities.eslint.severity = "low";
    recount(report);
    expect(run(report).ok).toBe(false);
  });

  it("rejects altered scope or expiration in the policy", () => {
    const { report, policy } = fresh();
    policy.expiresAt = "2030-11-15T23:00:00Z";
    expect(run(report, policy).ok).toBe(false);
    policy.expiresAt = originalPolicy.expiresAt;
    policy.ignoreAll = true;
    expect(run(report, policy).ok).toBe(false);
  });

  it("rejects an unrecognized reviewed cycle declaration", () => {
    const { report, policy } = fresh();
    policy.allowedCycles = [];
    expect(run(report, policy).ok).toBe(false);
  });

  it("keeps a clean ordinary audit independent of an expired or absent policy", () => {
    const { report } = fresh();
    report.vulnerabilities = {};
    recount(report);
    const result = run(report, null, originalLock, expiry + 1);
    expect(result.ok).toBe(true);
    expect(result.exceptionUsed).toBe(false);
  });

  it("preserves the ordinary moderate threshold for a low-only report", () => {
    const { report } = fresh();
    report.vulnerabilities = { minimatch: report.vulnerabilities.minimatch };
    report.vulnerabilities.minimatch.severity = "low";
    (report.vulnerabilities.minimatch.via[0] as Advisory).severity = "low";
    recount(report);
    expect(run(report, null, originalLock, expiry + 1).ok).toBe(true);
  });

  it("rejects a severe advisory hidden under a low-severity finding and exit zero", () => {
    const { report } = fresh();
    report.vulnerabilities = { minimatch: report.vulnerabilities.minimatch };
    report.vulnerabilities.minimatch.severity = "low";
    (report.vulnerabilities.minimatch.via[0] as Advisory).severity = "critical";
    recount(report);
    const result = run(report, null);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/severity is understated/);
  });

  it("rejects malformed schemas, empty causes and inconsistent metadata", () => {
    const { report } = fresh();
    report.auditReportVersion = 3;
    expect(run(report).ok).toBe(false);
    report.auditReportVersion = 2;
    report.vulnerabilities.minimatch.via = [];
    expect(run(report).ok).toBe(false);
    report.vulnerabilities.minimatch.via = structuredClone(originalReport.vulnerabilities.minimatch.via);
    report.metadata.vulnerabilities.moderate = 0;
    expect(run(report).ok).toBe(false);
  });

  it.each([
    { status: 2, signal: null, stdout: JSON.stringify(originalReport) },
    { status: null, signal: "SIGTERM", stdout: JSON.stringify(originalReport) },
    { status: 1, signal: null, stdout: "not JSON" },
    { status: 1, signal: null, stdout: JSON.stringify({ error: { code: "ENETUNREACH" } }) },
    { status: 1, signal: null, stdout: JSON.stringify(originalReport), error: new Error("network") },
    { status: 0, signal: null, stdout: JSON.stringify(originalReport) },
  ])("fails closed when npm audit cannot supply a consistent completed report", (execution) => {
    expect(evaluateAuditExecution(execution, originalLock, originalPolicy, now).ok).toBe(false);
  });
});
