import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadinessProbe, migrationChecksums, migrationStateMatches, type AppliedMigration } from "./readiness";

const expected = [{ name: "init", checksums: migrationChecksums("SELECT 1;\n") }];
const applied = (): AppliedMigration => ({
  migration_name: "init", checksum: expected[0].checksums[0],
  finished_at: new Date(), rolled_back_at: null,
});

afterEach(() => vi.useRealTimers());

describe("migration readiness", () => {
  it("accepts a completed exact schema manifest", () => {
    expect(migrationStateMatches(expected, [applied()])).toBe(true);
  });

  it("accepts only line-ending variants, not changed SQL", () => {
    const windows = migrationChecksums("SELECT 1;\r\n");
    expect(new Set(windows)).toEqual(new Set(expected[0].checksums));
    expect(migrationStateMatches(expected, [{ ...applied(), checksum: windows[0] }])).toBe(true);
    expect(migrationStateMatches(expected, [{ ...applied(), checksum: migrationChecksums("SELECT 2;\n")[0] }])).toBe(false);
  });

  it("fails closed for a missing manifest, unapplied/failed/extra migrations or checksum mismatch", () => {
    expect(migrationStateMatches([], [])).toBe(false);
    expect(migrationStateMatches(expected, [])).toBe(false);
    expect(migrationStateMatches(expected, [{ ...applied(), finished_at: null }])).toBe(false);
    expect(migrationStateMatches(expected, [applied(), { ...applied(), migration_name: "future" }])).toBe(false);
    expect(migrationStateMatches(expected, [{ ...applied(), checksum: "changed" }])).toBe(false);
  });

  it("ignores a rolled-back attempt only when a successful retry exists", () => {
    const rolledBack = { ...applied(), finished_at: null, rolled_back_at: new Date() };
    expect(migrationStateMatches(expected, [rolledBack])).toBe(false);
    expect(migrationStateMatches(expected, [rolledBack, applied()])).toBe(true);
  });
});

describe("bounded readiness probe", () => {
  it("handles errors without leaking details and recovers on the next check", async () => {
    const check = vi.fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("postgres://secret@private-host/db"))
      .mockResolvedValueOnce(true);
    const probe = createReadinessProbe(check);
    expect(await probe()).toBe(false);
    expect(await probe()).toBe(true);
  });

  it("shares a hanging check across timed-out requests without accumulating DB operations", async () => {
    vi.useFakeTimers();
    let finish!: (value: boolean) => void;
    const check = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const probe = createReadinessProbe(check, 25);
    const first = probe();
    const second = probe();
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(25);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    const third = probe();
    expect(third).toBe(first);
    await vi.advanceTimersByTimeAsync(25);
    expect(await third).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
    finish(true);
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears timeout timers on successful checks", async () => {
    vi.useFakeTimers();
    expect(await createReadinessProbe(async () => true)()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
