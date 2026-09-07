import type { HeartbeatResult } from "@/lib/queue/client";
import type { JobLease } from "@/lib/queue/types";
import type { InFlightJob } from "@/worker/shutdown";

export function claimKey(lease: Pick<JobLease, "id" | "leaseVersion">): string {
  return `${lease.id}:${lease.leaseVersion}`;
}

export function forgetClaim(inFlight: Map<string, InFlightJob>, entry: InFlightJob): void {
  const key = claimKey(entry.lease);
  if (inFlight.get(key) === entry) inFlight.delete(key);
}

/** Heartbeat snapshots must not act on a replacement generation. */
export function applyHeartbeat(entries: InFlightJob[], result: HeartbeatResult): void {
  const alive = new Set(result.alive.map(claimKey));
  const cancelled = new Set(result.cancelled);
  for (const entry of entries) {
    if (!alive.has(claimKey(entry.lease)) || cancelled.has(entry.id)) entry.controller.abort();
  }
}
