import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { getEnv } from "@/lib/env";

/**
 * Envelope encryption for provider API keys (AES-256-GCM).
 *
 * Two properties matter beyond confidentiality at rest:
 *
 * - The owner pair `(userId, providerId)` is authenticated as additional data,
 *   so a ciphertext copied onto another user's row fails to decrypt instead of
 *   silently handing that user someone else's paid key.
 * - Each row records the key version it was written with, and decryption looks
 *   the key up by that version rather than the current one. Rotation is then a
 *   matter of adding a version and bumping CREDENTIAL_KEY_CURRENT; existing
 *   rows stay readable and can be re-encrypted lazily.
 *
 * The plaintext key never appears in a log line, an error message or a thrown
 * value produced by this module.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface CredentialAad {
  userId: string;
  providerId: string;
}

export interface EncryptedCredential {
  cipherText: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
  fingerprint: string;
  lastFour: string;
}

/** The subset of a ProviderCredential row needed to recover the plaintext. */
export interface EncryptedCredentialRecord {
  cipherText: Buffer | Uint8Array;
  iv: Buffer | Uint8Array;
  authTag: Buffer | Uint8Array;
  keyVersion: number;
}

function keyForVersion(version: number): Buffer {
  const { CREDENTIAL_KEYS } = getEnv();
  const encoded = CREDENTIAL_KEYS[String(version)];
  if (!encoded) {
    const available = Object.keys(CREDENTIAL_KEYS).sort().join(", ") || "aucune";
    throw new Error(
      `Clé de chiffrement version ${version} absente de CREDENTIAL_KEYS (versions présentes : ${available}). ` +
        "Une version retirée rend définitivement illisibles les identifiants écrits avec elle."
    );
  }
  return Buffer.from(encoded, "base64");
}

function aadFor(aad: CredentialAad): Buffer {
  return Buffer.from(`${aad.userId}:${aad.providerId}`, "utf8");
}

function toBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Deterministic, so a key already stored can be spotted without decrypting anything. */
function fingerprintOf(plaintext: string): string {
  return createHmac("sha256", getEnv().CREDENTIAL_FINGERPRINT_PEPPER).update(plaintext, "utf8").digest("hex");
}

function lastFourOf(plaintext: string): string {
  return plaintext.slice(-4);
}

export function encryptCredential(plaintext: string, aad: CredentialAad): EncryptedCredential {
  const keyVersion = getEnv().CREDENTIAL_KEY_CURRENT;
  const key = keyForVersion(keyVersion);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aadFor(aad));
  const cipherText = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    cipherText,
    iv,
    authTag: cipher.getAuthTag(),
    keyVersion,
    fingerprint: fingerprintOf(plaintext),
    lastFour: lastFourOf(plaintext),
  };
}

export function decryptCredential(record: EncryptedCredentialRecord, aad: CredentialAad): string {
  const key = keyForVersion(record.keyVersion);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, toBuffer(record.iv), {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(aadFor(aad));
    decipher.setAuthTag(toBuffer(record.authTag));
    // `final()` is what verifies the tag: nothing may be returned before it.
    const plaintext = Buffer.concat([decipher.update(toBuffer(record.cipherText)), decipher.final()]);
    return plaintext.toString("utf8");
  } catch (err) {
    throw new Error(
      "Déchiffrement de la clé API impossible : donnée altérée, ou enregistrement associé à un autre compte ou fournisseur.",
      { cause: err }
    );
  }
}

export function needsRotation(record: { keyVersion: number }): boolean {
  return record.keyVersion !== getEnv().CREDENTIAL_KEY_CURRENT;
}

export function maskKey(lastFour: string): string {
  return `••••${lastFour}`;
}
