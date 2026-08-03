import { z } from "zod";

/**
 * Server-side environment, validated once at boot.
 *
 * This module refuses to start the app in production with placeholder secrets.
 * The alternative — silently accepting the value shipped in .env.example — is
 * how self-hosted deployments end up running with a publicly known session
 * secret, which lets anyone forge a session token.
 *
 * Never import this from a client component.
 */

const PLACEHOLDER_SECRETS = new Set([
  "change-me-in-production-please",
  "changeme",
  "secret",
]);

/** The development values shipped in .env.example, blocked in production. */
const PLACEHOLDER_CREDENTIAL_KEY = "ZGV2LW9ubHkta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=";
const PLACEHOLDER_PEPPER = "dev-only-pepper-change-me-in-production";

const base64Key32 = z.string().refine(
  (v) => {
    try {
      return Buffer.from(v, "base64").length === 32;
    } catch {
      return false;
    }
  },
  { message: "must be a base64-encoded 32-byte key" }
);

const credentialKeys = z
  .string()
  .transform((raw, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CREDENTIAL_KEYS must be JSON, e.g. {"1":"<base64 32 bytes>"}',
      });
      return z.NEVER;
    }
    const result = z.record(z.string().regex(/^\d+$/), base64Key32).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `CREDENTIAL_KEYS invalid: ${result.error.issues.map((i) => i.message).join(", ")}`,
      });
      return z.NEVER;
    }
    return result.data;
  });

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().min(1),

    NEXTAUTH_URL: z.string().url().optional(),
    NEXTAUTH_SECRET: z.string().min(16),

    // Credential encryption. Rotation: add a new version, bump CURRENT, then
    // re-encrypt existing rows in the background — old rows stay readable.
    CREDENTIAL_KEYS: credentialKeys,
    CREDENTIAL_KEY_CURRENT: z.coerce.number().int().positive(),
    CREDENTIAL_FINGERPRINT_PEPPER: z.string().min(16),

    // Model ids are configuration, not code. Hardcoding them is what silently
    // broke this application when two providers retired their 2025 models.
    OPENAI_MODEL: z.string().default("gpt-5.6-luna"),
    ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),
    GEMINI_MODEL: z.string().default("gemini-3.6-flash"),
    PERPLEXITY_MODEL: z.string().default("sonar"),

    SENTIMENT_JUDGE_PROVIDER: z.string().default("openai"),
    SENTIMENT_JUDGE_MODEL: z.string().default("gpt-5.6-luna"),
    SENTIMENT_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),

    // Number of reverse proxies in front of the app whose X-Forwarded-For
    // entries can be trusted. Zero means the forwarded headers are ignored: any
    // client can write them, so believing one hands out free rate-limit buckets.
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

    WORKER_ID: z.string().optional(),
    WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(50).default(5),

    SEED_DEMO: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),

    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
      if (PLACEHOLDER_SECRETS.has(env.NEXTAUTH_SECRET)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["NEXTAUTH_SECRET"],
          message:
            "refuses to start in production with the placeholder value from .env.example — generate one with `openssl rand -base64 32`",
        });
      }
      if (!env.NEXTAUTH_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["NEXTAUTH_URL"],
          message: "is required in production",
        });
      }
      if (env.SEED_DEMO) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["SEED_DEMO"],
          message: "must not be enabled in production — it creates a known-credentials account",
        });
      }
      if (Object.values(env.CREDENTIAL_KEYS).includes(PLACEHOLDER_CREDENTIAL_KEY)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CREDENTIAL_KEYS"],
          message:
            "still contains the development key from .env.example — every stored provider key would be decryptable by anyone. Run `npm run keygen`",
        });
      }
      if (env.CREDENTIAL_FINGERPRINT_PEPPER === PLACEHOLDER_PEPPER) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CREDENTIAL_FINGERPRINT_PEPPER"],
          message: "still holds the development value from .env.example — run `npm run keygen`",
        });
      }
    }
    if (!(String(env.CREDENTIAL_KEY_CURRENT) in env.CREDENTIAL_KEYS)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CREDENTIAL_KEY_CURRENT"],
        message: `points to version ${env.CREDENTIAL_KEY_CURRENT}, which is absent from CREDENTIAL_KEYS`,
      });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  cached = parsed.data;
  return cached;
}

/** Model id for a provider code, honouring env overrides. */
export function modelFor(providerCode: string): string {
  const env = getEnv();
  switch (providerCode) {
    case "openai":
      return env.OPENAI_MODEL;
    case "claude":
      return env.ANTHROPIC_MODEL;
    case "gemini":
      return env.GEMINI_MODEL;
    case "perplexity":
      return env.PERPLEXITY_MODEL;
    default:
      return "";
  }
}
