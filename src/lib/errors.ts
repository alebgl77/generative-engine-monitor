/**
 * Error taxonomy shared by providers, the queue and the API layer.
 *
 * The classification drives real behaviour: `retryable` decides whether the
 * queue re-enqueues a job, and `invalidatesCredential` decides whether we stop
 * burning the remaining calls of a run against a key we now know is dead.
 */

export type ErrorCode =
  | "AUTH"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "SERVER"
  | "NETWORK"
  | "BAD_REQUEST"
  | "MODEL_NOT_FOUND"
  | "UNSUPPORTED_MODE"
  | "PARSE"
  | "CANCELLED"
  | "UNKNOWN";

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "RATE_LIMIT",
  "TIMEOUT",
  "SERVER",
  "NETWORK",
]);

/** Codes that mean the API key itself is bad, not the request. */
const INVALIDATES_CREDENTIAL: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["AUTH"]);

export class ProviderError extends Error {
  readonly code: ErrorCode;
  readonly providerCode: string;
  readonly status?: number;
  /** Seconds to wait, parsed from a Retry-After header when the provider sent one. */
  readonly retryAfterSec?: number;
  readonly details?: string;

  constructor(
    code: ErrorCode,
    providerCode: string,
    message: string,
    options: { status?: number; retryAfterSec?: number; details?: string; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.code = code;
    this.providerCode = providerCode;
    this.status = options.status;
    this.retryAfterSec = options.retryAfterSec;
    this.details = options.details;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  get invalidatesCredential(): boolean {
    return INVALIDATES_CREDENTIAL.has(this.code);
  }
}

/** Maps an HTTP status to our taxonomy. 404 is ambiguous, so callers that can
 * tell a missing model from a missing route should pass the hint. */
export function codeFromStatus(status: number, hint?: "model"): ErrorCode {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status === 408) return "TIMEOUT";
  if (status === 404) return hint === "model" ? "MODEL_NOT_FOUND" : "BAD_REQUEST";
  if (status >= 500) return "SERVER";
  if (status >= 400) return "BAD_REQUEST";
  return "UNKNOWN";
}

/**
 * Database conditions a later attempt can clear: the connection was lost, the
 * pool was saturated, or two transactions collided. The queue must hand the
 * attempt back for these, so they carry a retryable classification.
 */
const PRISMA_REQUEST_CODES: Readonly<Record<string, ErrorCode>> = {
  P1001: "NETWORK",
  P1002: "NETWORK",
  P1008: "NETWORK",
  P1017: "NETWORK",
  P2024: "TIMEOUT",
  P2028: "SERVER",
  P2034: "SERVER",
};

/** Prisma error classes that mean the client itself is unusable right now. */
const PRISMA_CLIENT_ERRORS: ReadonlySet<string> = new Set([
  "PrismaClientInitializationError",
  "PrismaClientRustPanicError",
]);

/**
 * Recognises Prisma failures without importing the client: this module is
 * shared with the browser bundle, so the shape is inspected rather than the
 * class. Prisma stamps `name` on its error classes and exposes the `Pxxxx`
 * identifier as `code`.
 */
function prismaCodeFrom(err: unknown): ErrorCode | null {
  if (typeof err !== "object" || err === null) return null;

  const candidate = err as { name?: unknown; code?: unknown; constructor?: { name?: unknown } };
  const names = [candidate.name, candidate.constructor?.name];
  if (names.some((name) => typeof name === "string" && PRISMA_CLIENT_ERRORS.has(name))) {
    return "SERVER";
  }

  const code = candidate.code;
  if (typeof code === "string" && code in PRISMA_REQUEST_CODES) return PRISMA_REQUEST_CODES[code];

  return null;
}

/** Classifies a thrown value from `fetch` (abort, DNS failure, socket reset…) or Prisma. */
export function codeFromThrown(err: unknown): ErrorCode {
  if (err instanceof ProviderError) return err.code;
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return "TIMEOUT";
    if (err.name === "TypeError") return "NETWORK";
  }
  return prismaCodeFrom(err) ?? "UNKNOWN";
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  return RETRYABLE.has(codeFromThrown(err));
}

/** Application-level error carrying an HTTP status, thrown by API route helpers. */
export class AppError extends Error {
  readonly status: number;
  readonly publicMessage: string;

  constructor(status: number, publicMessage: string, internalMessage?: string) {
    super(internalMessage ?? publicMessage);
    this.name = "AppError";
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

export const unauthorized = () => new AppError(401, "Non authentifié");
export const forbidden = () => new AppError(403, "Accès refusé");
export const notFound = (what = "Ressource") => new AppError(404, `${what} introuvable`);
export const badRequest = (msg: string) => new AppError(400, msg);
export const tooManyRequests = (msg = "Trop de requêtes, réessayez plus tard") =>
  new AppError(429, msg);
