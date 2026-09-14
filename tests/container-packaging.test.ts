import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const processTimeoutMs = process.platform === "win32" ? 30_000 : 10_000;
const caseTimeoutMs = processTimeoutMs + 5_000;
const shellPath = (path: string) => path.replaceAll("\\", "/")
  .replace(/^([a-z]):\//i, (_, drive: string) => `/${drive.toLowerCase()}/`);
let testDir: string;

// These tests exercise Bash control flow, never a Docker daemon. Actual image
// builds, native engines and Compose semantics belong to the Linux Docker job.
const mockDocker = `
timeout() { shift; "$@"; }
docker() {
  printf '%s\\n' "$*" >> "$MOCK_TRACE"
  case "$1" in
    container) return 0 ;;
    run) echo 'mock HTTP smoke'; return "\${MOCK_HTTP_EXIT:-0}" ;;
    inspect)
      case "$3" in
        '{{.State.Status}}:{{.State.ExitCode}}') echo exited:0 ;;
        '{{.State.Status}}') echo exited ;;
        '{{.State.ExitCode}}')
          if [[ "\${MOCK_EXIT_CODE_INSPECT_ERROR:-0}" == 1 ]]; then return 1; fi
          echo 1 ;;
        '{{.State.Health.Status}}') echo healthy ;;
        '{{.State.Error}}')
          if [[ "\${MOCK_INSPECT_ERROR:-0}" == 1 ]]; then return 1; fi
          echo "\${MOCK_STATE_ERROR:-}" ;;
        '{{.State.StartedAt}}')
          if [[ "\${MOCK_WRITER_STARTED:-0}" == 1 ]]; then echo 2026-09-03T10:00:00Z;
          else echo 0001-01-01T00:00:00Z; fi ;;
        *) return 98 ;;
      esac
      return 0 ;;
    compose) shift ;;
    *) return 98 ;;
  esac
  local project=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env-file|-f) shift 2 ;;
      --project-name) project=$2; shift 2 ;;
      *) break ;;
    esac
  done
  case "$1" in
    config|build) return 0 ;;
    down) return "\${MOCK_CLEANUP_EXIT:-0}" ;;
    stop) return "\${MOCK_STOP_EXIT:-0}" ;;
    logs) echo 'safe disposable container log' ;;
    up) if [[ "$project" == *-blocked ]]; then return "\${MOCK_NEGATIVE_EXIT:-1}"; fi ;;
    ps) echo "$project-\${*: -1}" ;;
    port) echo 127.0.0.1:54320 ;;
    exec) if [[ "\${*: -1}" == -u ]]; then echo "\${MOCK_UID:-1001}"; fi ;;
    *) return 98 ;;
  esac
}
`;

beforeEach(() => {
  testDir = mkdtempSync(join(root, "..", "gem-container-test-"));
  mkdirSync(join(testDir, "logs"));
});
afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

function run(environment: Record<string, string | undefined> = {}) {
  const tracePath = join(testDir, "commands.log");
  const result = spawnSync(bash, ["-c", `PATH=/usr/bin:/bin:$PATH\n${mockDocker}\nsource "$SMOKE_SCRIPT"`], {
    cwd: root,
    encoding: "utf8",
    timeout: processTimeoutMs,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      BASH_ENV: "/dev/null",
      ENV: "/dev/null",
      TMPDIR: shellPath(testDir),
      MOCK_TRACE: shellPath(tracePath),
      SMOKE_SCRIPT: shellPath(join(root, "scripts/container-smoke.sh")),
      CONTAINER_SMOKE_ALLOW_MUTATION: "1",
      // Git Bash mkdir -p traverses denied Windows ancestors for absolute
      // paths, even when this workspace-scoped directory already exists.
      CONTAINER_SMOKE_LOG_DIR: shellPath(relative(root, join(testDir, "logs"))),
      ...environment,
    },
  });
  expect(result.error).toBeUndefined();
  return { ...result, trace: existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "" };
}

function expectScopedCleanup(trace: string) {
  const projects = [...new Set([...trace.matchAll(/--project-name (\S+)/g)].map((match) => match[1]))];
  expect(projects).toHaveLength(2);
  expect(projects[0]).toMatch(/^gem-smoke-[a-z0-9]{8}$/);
  expect(projects[1]).toBe(`${projects[0]}-blocked`);
  for (const project of projects) {
    expect(trace.split("\n").some((line) => line.includes(`--project-name ${project} `)
      && line.includes("down --volumes --remove-orphans --timeout 120"))).toBe(true);
  }
  expect(trace).not.toMatch(/(?:system|volume) prune|docker login|docker push/);
}

describe("container smoke orchestration (Docker mocked)", () => {
  it("requires explicit fixture mutation consent before invoking Docker", () => {
    const result = run({ CONTAINER_SMOKE_ALLOW_MUTATION: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("disposable Docker test host");
    expect(result.trace).toBe("");
  }, caseTimeoutMs);

  it("builds every target, checks runtime gates and cleans only its generated projects", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS container smoke");
    expect(result.trace).toContain("build web worker migrate");
    expect(result.trace).toContain("up -d --no-build --wait --wait-timeout 150 web worker");
    expect(result.trace).toContain("exec -T worker node scripts/worker-health.mjs");
    expect(result.trace).toContain("exec -T web id -u");
    expect(result.trace).toContain("exec -T worker id -u");
    expect(result.trace).toContain("--network host --entrypoint node");
    expect(result.trace).toContain("--env-file /dev/null");
    expect(result.trace).toContain("config --quiet");
    const stopped = result.trace.indexOf("stop web worker");
    const negativeStart = result.trace.split("\n").find((line) => line.includes("-blocked ") && line.includes(" up "))!;
    expect(stopped).toBeGreaterThan(result.trace.indexOf("--network host --entrypoint node"));
    expect(stopped).toBeLessThan(result.trace.indexOf(negativeStart));
    expectScopedCleanup(result.trace);
  }, caseTimeoutMs);

  it("preserves diagnostic logs and cleans both projects after HTTP smoke failure", () => {
    const result = run({ MOCK_HTTP_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(readFileSync(join(testDir, "logs/http-smoke.log"), "utf8")).toContain("mock HTTP smoke");
    expect(result.stderr).toContain("Container smoke failed; logs:");
    expectScopedCleanup(result.trace);
  }, caseTimeoutMs);

  it("does not start the negative project when positive writers cannot be stopped", () => {
    const result = run({ MOCK_STOP_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.trace.split("\n").some((line) => line.includes("-blocked ") && line.includes(" up "))).toBe(false);
    expectScopedCleanup(result.trace);
  }, caseTimeoutMs);

  it("reports cleanup failure even when all qualification gates pass", () => {
    const result = run({ MOCK_CLEANUP_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Container smoke failed; logs:");
    expectScopedCleanup(result.trace);
  }, caseTimeoutMs);

  it.each([
    { MOCK_NEGATIVE_EXIT: "0" },
    { MOCK_NEGATIVE_EXIT: "124" },
    { MOCK_NEGATIVE_EXIT: "137" },
    { MOCK_WRITER_STARTED: "1" },
    { MOCK_STATE_ERROR: "port already allocated" },
    { MOCK_INSPECT_ERROR: "1" },
    { MOCK_EXIT_CODE_INSPECT_ERROR: "1" },
    { MOCK_UID: "0" },
  ])("rejects a false migration gate or root runtime: %j", (environment) => {
    const result = run(environment);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("PASS container smoke");
    expectScopedCleanup(result.trace);
  }, caseTimeoutMs);
});
