import { describe, expect, it } from "vitest";
import { applyHeartbeat, claimKey, forgetClaim } from "@/worker/inflight";
import type { InFlightJob } from "@/worker/shutdown";

function entry(leaseVersion: number): InFlightJob {
  return { id: "same", lease: { id: "same", leaseVersion, lockedBy: "same-worker", runId: "r" }, controller: new AbortController(), done: Promise.resolve() };
}
describe("in-flight generations", () => {
  it("finishing an older attempt cannot remove a replacement", () => {
    const old = entry(1), current = entry(2);
    const tracked = new Map([[claimKey(old.lease), old], [claimKey(current.lease), current]]);
    forgetClaim(tracked, old);
    expect([...tracked.values()]).toEqual([current]);
  });
  it("heartbeat ownership of a replacement never keeps the older attempt alive", () => {
    const old = entry(1), current = entry(2);
    applyHeartbeat([old, current], { alive: [{ id: "same", leaseVersion: 2 }], cancelled: [] });
    expect(old.controller.signal.aborted).toBe(true);
    expect(current.controller.signal.aborted).toBe(false);
  });
  it("cancellation aborts the currently owned generation", () => {
    const current = entry(2);
    applyHeartbeat([current], { alive: [{ id: "same", leaseVersion: 2 }], cancelled: ["same"] });
    expect(current.controller.signal.aborted).toBe(true);
  });
});
