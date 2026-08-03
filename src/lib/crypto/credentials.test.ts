import { describe, expect, it, vi } from "vitest";

import type { CredentialAad, EncryptedCredentialRecord } from "@/lib/crypto/credentials";

/**
 * Two key versions are configured so rotation can be exercised end to end: a row
 * written under version 1 must stay readable once version 2 becomes current.
 */
const KEY_V1 = Buffer.alloc(32, 0x11).toString("base64");
const KEY_V2 = Buffer.alloc(32, 0x22).toString("base64");

process.env.DATABASE_URL = "postgresql://gem:gem@localhost:5432/gem_test";
process.env.NEXTAUTH_SECRET = "test-nextauth-secret-value";
process.env.CREDENTIAL_KEYS = JSON.stringify({ "1": KEY_V1, "2": KEY_V2 });
process.env.CREDENTIAL_FINGERPRINT_PEPPER = "test-fingerprint-pepper-value";
process.env.CREDENTIAL_KEY_CURRENT = "1";

type CredentialsModule = typeof import("@/lib/crypto/credentials");

/** The env module caches its parse, so a version change needs a fresh registry. */
async function loadWithCurrentVersion(version: number): Promise<CredentialsModule> {
  process.env.CREDENTIAL_KEY_CURRENT = String(version);
  vi.resetModules();
  return import("@/lib/crypto/credentials");
}

const OWNER: CredentialAad = { userId: "user-1", providerId: "provider-openai" };
const SECRET = "not-a-real-key-fixture-0123456789";

function messagesOf(err: unknown): string {
  const seen: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    seen.push(current.message, current.stack ?? "", String(current));
    current = current.cause;
  }
  return seen.join("\n");
}

describe("encryptCredential / decryptCredential", () => {
  it("recovers the plaintext it was given", async () => {
    const { decryptCredential, encryptCredential } = await loadWithCurrentVersion(1);

    const record = encryptCredential(SECRET, OWNER);

    expect(record.keyVersion).toBe(1);
    expect(record.lastFour).toBe(SECRET.slice(-4));
    expect(record.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(record.iv).toHaveLength(12);
    expect(record.authTag).toHaveLength(16);
    expect(record.cipherText.toString("utf8")).not.toContain(SECRET);
    expect(decryptCredential(record, OWNER)).toBe(SECRET);
  });

  it("produces a fresh ciphertext and iv per call while the fingerprint stays stable", async () => {
    const { encryptCredential } = await loadWithCurrentVersion(1);

    const first = encryptCredential(SECRET, OWNER);
    const second = encryptCredential(SECRET, OWNER);

    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.cipherText.equals(second.cipherText)).toBe(false);
    expect(first.authTag.equals(second.authTag)).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("gives the same fingerprint to the same key stored by two different owners", async () => {
    const { encryptCredential } = await loadWithCurrentVersion(1);

    const mine = encryptCredential(SECRET, OWNER);
    const theirs = encryptCredential(SECRET, { userId: "user-2", providerId: OWNER.providerId });

    expect(theirs.fingerprint).toBe(mine.fingerprint);
  });

  it("refuses a record read under another user", async () => {
    const { decryptCredential, encryptCredential } = await loadWithCurrentVersion(1);
    const record = encryptCredential(SECRET, OWNER);

    expect(() => decryptCredential(record, { ...OWNER, userId: "user-2" })).toThrow(
      /Déchiffrement de la clé API impossible/
    );
  });

  it("refuses a record read under another provider", async () => {
    const { decryptCredential, encryptCredential } = await loadWithCurrentVersion(1);
    const record = encryptCredential(SECRET, OWNER);

    expect(() => decryptCredential(record, { ...OWNER, providerId: "provider-claude" })).toThrow(
      /Déchiffrement de la clé API impossible/
    );
  });

  it("refuses a tampered ciphertext", async () => {
    const { decryptCredential, encryptCredential } = await loadWithCurrentVersion(1);
    const record = encryptCredential(SECRET, OWNER);
    const tampered = Buffer.from(record.cipherText);
    tampered[0] ^= 0xff;

    expect(() => decryptCredential({ ...record, cipherText: tampered }, OWNER)).toThrow();
  });

  it("refuses a record whose auth tag comes from another row", async () => {
    const { decryptCredential, encryptCredential } = await loadWithCurrentVersion(1);
    const record = encryptCredential(SECRET, OWNER);
    const other = encryptCredential(SECRET, OWNER);

    expect(() => decryptCredential({ ...record, authTag: other.authTag }, OWNER)).toThrow();
  });

  it("accepts a Uint8Array row exactly as a Buffer one", async () => {
    const { decryptCredential, encryptCredential } = await loadWithCurrentVersion(1);
    const record = encryptCredential(SECRET, OWNER);

    const asBytes: EncryptedCredentialRecord = {
      cipherText: new Uint8Array(record.cipherText),
      iv: new Uint8Array(record.iv),
      authTag: new Uint8Array(record.authTag),
      keyVersion: record.keyVersion,
    };

    expect(decryptCredential(asBytes, OWNER)).toBe(SECRET);
  });
});

describe("key rotation", () => {
  it("still reads a version 1 row once version 2 is current", async () => {
    const v1 = await loadWithCurrentVersion(1);
    const legacy = v1.encryptCredential(SECRET, OWNER);
    expect(legacy.keyVersion).toBe(1);

    const v2 = await loadWithCurrentVersion(2);
    const fresh = v2.encryptCredential(SECRET, OWNER);

    expect(fresh.keyVersion).toBe(2);
    expect(v2.decryptCredential(legacy, OWNER)).toBe(SECRET);
    expect(v2.decryptCredential(fresh, OWNER)).toBe(SECRET);
    expect(legacy.fingerprint).toBe(fresh.fingerprint);
  });

  it("flags exactly the rows written under an older version", async () => {
    const v1 = await loadWithCurrentVersion(1);
    expect(v1.needsRotation({ keyVersion: 1 })).toBe(false);
    expect(v1.needsRotation({ keyVersion: 2 })).toBe(true);

    const v2 = await loadWithCurrentVersion(2);
    expect(v2.needsRotation({ keyVersion: 1 })).toBe(true);
    expect(v2.needsRotation({ keyVersion: 2 })).toBe(false);
  });

  it("names the missing version and the ones available when a key is gone", async () => {
    const { decryptCredential, encryptCredential } = await loadWithCurrentVersion(2);
    const record = encryptCredential(SECRET, OWNER);

    let thrown: unknown;
    try {
      decryptCredential({ ...record, keyVersion: 7 }, OWNER);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("version 7");
    expect((thrown as Error).message).toContain("CREDENTIAL_KEYS");
    expect((thrown as Error).message).toContain("1, 2");
  });
});

describe("secret exposure", () => {
  it("leaks nothing beyond the last four characters through maskKey", async () => {
    const { encryptCredential, maskKey } = await loadWithCurrentVersion(2);
    const record = encryptCredential(SECRET, OWNER);
    const masked = maskKey(record.lastFour);

    expect(record.lastFour).toHaveLength(4);
    expect(masked).toBe(`••••${SECRET.slice(-4)}`);
    expect(masked).not.toContain(SECRET.slice(0, -4));
    expect(masked.replace(/•/g, "")).toHaveLength(4);
  });

  it("keeps the plaintext out of every message on the failure paths", async () => {
    const { decryptCredential, encryptCredential } = await loadWithCurrentVersion(2);
    const record = encryptCredential(SECRET, OWNER);

    const failures: unknown[] = [];
    const attempts: (() => unknown)[] = [
      () => decryptCredential(record, { ...OWNER, userId: "intruder" }),
      () => decryptCredential({ ...record, keyVersion: 9 }, OWNER),
      () => decryptCredential({ ...record, iv: Buffer.alloc(12) }, OWNER),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (err) {
        failures.push(err);
      }
    }

    expect(failures).toHaveLength(attempts.length);
    for (const failure of failures) {
      const text = messagesOf(failure);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(SECRET.slice(0, 12));
      expect(text).not.toContain(KEY_V1);
      expect(text).not.toContain(KEY_V2);
    }
  });
});
