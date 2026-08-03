import { describe, expect, it } from "vitest";

import { ProviderError, codeFromStatus, codeFromThrown, isRetryable } from "@/lib/errors";

/**
 * Stands in for `Prisma.PrismaClientKnownRequestError`: the classifier reads the
 * shape, not the class, so the double is enough — and the taxonomy stays usable
 * everywhere the client is not.
 */
class PrismaKnownRequestErrorDouble extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`prisma request failed (${code})`);
    this.name = "PrismaClientKnownRequestError";
    this.code = code;
  }
}

class PrismaClientErrorDouble extends Error {
  constructor(name: string) {
    super(`prisma client failed (${name})`);
    this.name = name;
  }
}

describe("codeFromThrown", () => {
  it.each([
    ["P1001", "NETWORK"],
    ["P1002", "NETWORK"],
    ["P1008", "NETWORK"],
    ["P1017", "NETWORK"],
    ["P2024", "TIMEOUT"],
    ["P2028", "SERVER"],
    ["P2034", "SERVER"],
  ])("classifies the Prisma code %s as %s, which the queue retries", (code, expected) => {
    const err = new PrismaKnownRequestErrorDouble(code);

    expect(codeFromThrown(err)).toBe(expected);
    expect(isRetryable(err)).toBe(true);
  });

  it.each(["PrismaClientInitializationError", "PrismaClientRustPanicError"])(
    "treats %s as a server condition worth another attempt",
    (name) => {
      const err = new PrismaClientErrorDouble(name);

      expect(codeFromThrown(err)).toBe("SERVER");
      expect(isRetryable(err)).toBe(true);
    }
  );

  it("recognises a Prisma error class by its constructor name alone", () => {
    class PrismaClientRustPanicError extends Error {}

    expect(codeFromThrown(new PrismaClientRustPanicError("panic"))).toBe("SERVER");
  });

  it("leaves a Prisma code the application must handle itself unclassified", () => {
    const err = new PrismaKnownRequestErrorDouble("P2002");

    expect(codeFromThrown(err)).toBe("UNKNOWN");
    expect(isRetryable(err)).toBe(false);
  });

  it("leaves a plain error unclassified", () => {
    const err = new Error("boum");

    expect(codeFromThrown(err)).toBe("UNKNOWN");
    expect(isRetryable(err)).toBe(false);
  });

  it("leaves a thrown non-object unclassified", () => {
    expect(codeFromThrown("boum")).toBe("UNKNOWN");
    expect(codeFromThrown(null)).toBe("UNKNOWN");
    expect(codeFromThrown(undefined)).toBe("UNKNOWN");
  });

  it("keeps the abort and network classifications of a failed fetch", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const network = new TypeError("fetch failed");

    expect(codeFromThrown(abort)).toBe("TIMEOUT");
    expect(codeFromThrown(network)).toBe("NETWORK");
  });

  it("keeps the code a provider error already carries", () => {
    const err = new ProviderError("AUTH", "openai", "Clé API refusée");

    expect(codeFromThrown(err)).toBe("AUTH");
    expect(isRetryable(err)).toBe(false);
    expect(err.invalidatesCredential).toBe(true);
  });
});

describe("codeFromStatus", () => {
  it("separates a missing model from a missing route", () => {
    expect(codeFromStatus(404, "model")).toBe("MODEL_NOT_FOUND");
    expect(codeFromStatus(404)).toBe("BAD_REQUEST");
  });
});
