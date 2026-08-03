import type { ScoringVersion } from "@/lib/scoring/types";
import { v2 } from "@/lib/scoring/versions/v2";
import { v3 } from "@/lib/scoring/versions/v3";

// A released version file is never edited — new behaviour is a new file, so that
// scores already persisted under an old version stay reproducible.
const VERSIONS: ReadonlyMap<string, ScoringVersion> = new Map([
  [v2.version, v2],
  [v3.version, v3],
]);

export const CURRENT_SCORING_VERSION = "v3";

export function getScoringVersion(version: string): ScoringVersion {
  const found = VERSIONS.get(version);
  if (!found) {
    throw new Error(
      `Unknown scoring version "${version}" (known: ${listScoringVersions().join(", ")})`
    );
  }
  return found;
}

export function listScoringVersions(): string[] {
  return Array.from(VERSIONS.keys());
}
