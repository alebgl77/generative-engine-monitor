import { describe, expect, it } from "vitest";

import { RETRY, backoffSeconds } from "@/lib/queue/types";

/** Draws that pin the jitter factor to the bottom, middle and top of its band. */
const lowest = () => 0;
const middle = () => 0.5;
const highest = () => 0.999999;

/** The delay the policy asks for before the jitter is applied. */
function ceiling(attempt: number): number {
  return Math.min(RETRY.maxDelaySec, RETRY.baseDelaySec * 2 ** attempt);
}

describe("backoffSeconds", () => {
  it("waits before the first retry", () => {
    for (const random of [lowest, middle, highest]) {
      expect(backoffSeconds(0, random)).toBeGreaterThan(0);
    }
    expect(backoffSeconds(0, middle)).toBe(RETRY.baseDelaySec);
  });

  it("doubles the delay on every attempt while below the ceiling", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6].map((attempt) => backoffSeconds(attempt, middle));

    expect(delays[0]).toBe(RETRY.baseDelaySec);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBe(delays[i - 1] * 2);
      expect(delays[i]).toBeLessThanOrEqual(RETRY.maxDelaySec);
    }
  });

  it("stops growing at the configured ceiling", () => {
    for (const attempt of [8, 12, 40, 1024]) {
      expect(backoffSeconds(attempt, middle)).toBe(RETRY.maxDelaySec);
      expect(backoffSeconds(attempt, highest)).toBeLessThanOrEqual(
        Math.round(RETRY.maxDelaySec * (1 + RETRY.jitter))
      );
      expect(backoffSeconds(attempt, lowest)).toBeGreaterThanOrEqual(
        Math.round(RETRY.maxDelaySec * (1 - RETRY.jitter))
      );
    }
  });

  it("stays inside the jitter band for every draw", () => {
    const draws = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999999];

    for (let attempt = 0; attempt <= 10; attempt++) {
      const base = ceiling(attempt);
      for (const draw of draws) {
        const delay = backoffSeconds(attempt, () => draw);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(base * (1 - RETRY.jitter)));
        expect(delay).toBeLessThanOrEqual(Math.ceil(base * (1 + RETRY.jitter)));
      }
    }
  });

  it("spreads the retries of a mass failure instead of synchronising them", () => {
    expect(backoffSeconds(5, lowest)).not.toBe(backoffSeconds(5, highest));
  });

  it("is a pure function of the attempt and the draw", () => {
    expect(backoffSeconds(3, middle)).toBe(backoffSeconds(3, middle));
  });

  it("keeps the same guarantees with the ambient random source", () => {
    for (let i = 0; i < 200; i++) {
      const attempt = i % 9;
      const delay = backoffSeconds(attempt);
      const base = ceiling(attempt);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeGreaterThanOrEqual(Math.floor(base * (1 - RETRY.jitter)));
      expect(delay).toBeLessThanOrEqual(Math.ceil(base * (1 + RETRY.jitter)));
    }
  });
});
