import { getEnv } from "@/lib/env";

/**
 * Structured logging, one JSON object per line.
 *
 * Every field goes through `redact()` before serialisation. This application
 * handles provider API keys, and the cheapest way to leak one is to log the
 * object that happens to carry it — so the redaction is unconditional and
 * recursive rather than left to each call site.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /key|secret|token|password|authorization/i;
const REDACTED = "[redacted]";
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;

export type LogFields = Record<string, unknown>;

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && value in LEVEL_WEIGHT;
}

function currentLevel(): LogLevel {
  try {
    return getEnv().LOG_LEVEL;
  } catch {
    // A malformed environment must still be reportable.
    const raw = process.env.LOG_LEVEL;
    return isLogLevel(raw) ? raw : "info";
  }
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return value;
  if (type === "bigint") return String(value);
  if (type === "function" || type === "symbol") return undefined;

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[binary ${value.byteLength} bytes]`;
  }

  const asObject = value as object;
  if (seen.has(asObject)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  seen.add(asObject);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => redactValue(item, depth + 1, seen));
    return value.length > MAX_ARRAY ? [...items, `[+${value.length - MAX_ARRAY} more]`] : items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    const redacted = redactValue(item, depth + 1, seen);
    if (redacted !== undefined) out[key] = redacted;
  }
  return out;
}

/** Exported for call sites that must sanitise a payload before storing it. */
export function redact(fields: LogFields): LogFields {
  return redactValue(fields, 0, new WeakSet()) as LogFields;
}

function emit(level: LogLevel, msg: string, fields?: LogFields): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel()]) return;

  const line: Record<string, unknown> = { level, time: new Date().toISOString(), msg };
  if (fields) {
    for (const [key, value] of Object.entries(redact(fields))) {
      if (!(key in line)) line[key] = value;
    }
  }

  let serialised: string;
  try {
    serialised = JSON.stringify(line);
  } catch {
    serialised = JSON.stringify({ level, time: line.time, msg, logError: "champs non sérialisables" });
  }

  if (level === "error") console.error(serialised);
  else if (level === "warn") console.warn(serialised);
  else console.log(serialised);
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};
