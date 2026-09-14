import { describe, expect, it } from "vitest";
import { formatInterval, formatScore, formatStability, type ScoreDistribution } from "@/components/dashboard/score-bar";

const absent: ScoreDistribution = { median: null, ciLow: null, ciHigh: null, stability: null, n: 0, lowN: true };
describe("unavailable measurements", () => {
  it("never formats absent data as zero", () => {
    expect(formatScore(absent)).toBe("—");
    expect(formatStability(absent)).toBe("—");
    expect(formatInterval(absent)).toBe("IC indisponible");
  });
  it("keeps a real zero estimate separate from unavailable uncertainty", () => {
    expect(formatScore({ ...absent, median: 0, n: 1 })).toBe("≈ 0");
    expect(formatInterval({ ...absent, median: 0, n: 1 })).toBe("IC indisponible");
  });
});
