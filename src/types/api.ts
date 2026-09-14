import type {
  RunStatus,
  SamplingMode,
  Sentiment,
  TaskStatus,
} from "@prisma/client";
import type { ScoreContribution } from "@/lib/scoring/types";
import type { PairedRetrievalEstimate } from "@/lib/scoring/cluster-stats";

/**
 * The API contract, imported by both the route handlers and the pages.
 *
 * A page that declares its own copy of a response shape keeps compiling after
 * the endpoint changes and breaks at runtime instead. Sharing the definitions
 * turns that into a type error.
 */

/**
 * A distribution, never a bare number. `lowN` marks a sample count too small
 * for the interval to be read as a claim — the UI renders those as a
 * directional band rather than a figure.
 */
export interface AxisSummary {
  median: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  stability: number | null;
  n: number;
  rawN?: number | null;
  cellN?: number | null;
  ciMethod?: string;
  nUnit?: "queries" | "samples";
  lowN: boolean;
  brandPresenceRate: number;
}

export interface RunProgress {
  totalTasks: number;
  totalSamples: number;
  doneSamples: number;
  failedSamples: number;
  nPlanned?: number;
  nSuccessful?: number;
  nScored?: number;
  missingAnalysis?: number;
}

export interface EntityShare {
  entityId: string;
  name: string;
  kind: "BRAND" | "COMPETITOR";
  mentionShare: number;
  citationShare: number;
  presenceRate: number;
  avgOrderRank: number | null;
}

export interface SourceRow {
  domain: string;
  citationCount: number;
  sampleCount: number;
  citationShare: number;
  isBrandDomain: boolean;
  modes: SamplingMode[];
  providers: string[];
  queries: string[];
}

export interface ProviderModeScore extends AxisSummary {
  providerCode: string;
  providerLabel: string;
  mode: SamplingMode;
}

export interface OverviewResponse {
  scoringVersion: string;
  latestRun: { id: string; status: RunStatus; progress: RunProgress; completedAt: string | null } | null;
  /** What the engines retrieve live. Null when the run planned no grounded cell. */
  grounded: AxisSummary | null;
  /** What the models retained from training. */
  parametric: AxisSummary | null;
  /**
   * Equal-query mean of paired within-provider GROUNDED - PARAMETRIC differences.
   * Descriptive, not a causal estimate or a subtraction of pooled medians.
   */
  retrievalGap: number | null;
  retrieval?: Omit<PairedRetrievalEstimate, "queryValues"> | null;
  totalQueries: number;
  shareOfVoice: EntityShare[];
  topSources: SourceRow[];
  scoreByProviderMode: ProviderModeScore[];
}

export interface QueryCell extends AxisSummary {
  providerCode: string;
  providerLabel: string;
  mode: SamplingMode;
  taskId: string;
  status: TaskStatus;
}

export interface QueryRow {
  queryId: string;
  text: string;
  cells: QueryCell[];
  brandPresenceRate: number;
  competitors: { name: string; mentionShare: number }[];
  avgCitations: number;
}

export interface QueriesResponse {
  scoringVersion: string;
  runId: string | null;
  rows: QueryRow[];
}

export interface SourcesResponse {
  runId: string | null;
  scoringVersion?: string;
  extractionVersion?: string;
  rows: SourceRow[];
}

export interface RunTaskSummary {
  id: string;
  mode: SamplingMode;
  status: TaskStatus;
  query: { id: string; text: string };
  provider: { code: string; label: string };
  samples: { total: number; done: number; failed: number };
  score: AxisSummary | null;
  errorMessage: string | null;
}

/**
 * Task states for the whole run. A large project plans hundreds of tasks and the
 * run list is polled while a run advances, so the embedded tasks are a bounded
 * page and these counters carry the complete picture.
 */
export interface RunTaskCounts {
  total: number;
  byStatus: Record<TaskStatus, number>;
}

export interface RunSummary {
  id: string;
  status: RunStatus;
  scoringVersion: string;
  repetitions: number;
  modes: SamplingMode[];
  progress: RunProgress;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  taskCounts: RunTaskCounts;
  /** A page of the run's tasks in plan order; `taskCounts.total` is the whole. */
  tasks: RunTaskSummary[];
}

export interface RunsResponse {
  runs: RunSummary[];
}

/** One API call and everything derived from it — the explainability view. */
export interface SampleDetail {
  id: string;
  sampleIndex: number;
  status: string;
  model: string | null;
  latencyMs: number | null;
  errorMessage: string | null;
  /** An excerpt of the stored answer: the offsets below index this string. */
  text: string | null;
  /** The stored answer runs past the excerpt, so evidence can point outside it. */
  textTruncated: boolean;
  score: number | null;
  contributions: ScoreContribution[];
  mentions: {
    entityId: string;
    entityName: string;
    kind: "BRAND" | "COMPETITOR";
    mentionType: string;
    charOffset: number;
    occurrencesTotal: number;
    orderRank: number;
    sentiment: Sentiment | null;
    context: string;
  }[];
  citations: { url: string; domain: string; title: string | null; isBrandDomain: boolean; sourceKind: string }[];
}

export interface RunDetailResponse extends RunSummary {
  /** The same page as `tasks`, each task expanded with its samples. */
  tasksDetail: (RunTaskSummary & { samples: SampleDetail[] })[];
}

export interface CredentialSummary {
  id: string;
  providerId: string;
  providerCode: string;
  providerLabel: string;
  /** Masked — the plaintext key is never returned by any endpoint. */
  maskedKey: string;
  keyVersion: number;
  isValid: boolean;
  lastValidatedAt: string | null;
  validationError: string | null;
}

export interface ProviderSummary {
  id: string;
  code: string;
  label: string;
  supportsParametric: boolean;
  supportsGrounded: boolean;
  defaultModel: string;
  hasCredential: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  domain: string | null;
  targetCountry: string;
  targetLanguage: string;
  repetitions: number;
  samplingModes: SamplingMode[];
  activeScoringVersion: string;
  createdAt: string;
  counts: { brands: number; competitors: number; queries: number };
  lastRunAt: string | null;
}

export interface RunCreatedResponse {
  runId: string;
  totalTasks: number;
  totalSamples: number;
  /** Cells skipped because the provider cannot serve that mode. */
  skipped: { providerCode: string; mode: SamplingMode; reason: string }[];
}

export interface ApiErrorResponse {
  error: string;
}
