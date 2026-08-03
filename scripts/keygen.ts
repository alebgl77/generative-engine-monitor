import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Prints a fresh set of secrets for a first install, or writes them into .env
 * with `--write`.
 *
 * Deliberately free of any import from the application: it has to run before a
 * valid environment exists, which is precisely the situation env.ts refuses.
 */

function base64Key32(): string {
  return randomBytes(32).toString("base64");
}

const credentialKeys = JSON.stringify({ "1": base64Key32() });

const SECRET_KEYS = [
  "NEXTAUTH_SECRET",
  "CREDENTIAL_KEYS",
  "CREDENTIAL_KEY_CURRENT",
  "CREDENTIAL_FINGERPRINT_PEPPER",
] as const;

const assignments = [
  `NEXTAUTH_SECRET=${base64Key32()}`,
  `CREDENTIAL_KEYS=${credentialKeys}`,
  "CREDENTIAL_KEY_CURRENT=1",
  `CREDENTIAL_FINGERPRINT_PEPPER=${base64Key32()}`,
];

/**
 * Replaces the secret assignments in .env, leaving every other line untouched.
 * Refuses to run when a credential key is already present: overwriting it makes
 * every stored provider key permanently unreadable.
 */
function writeEnv(path: string): void {
  if (!existsSync(path)) {
    console.error(`${path} introuvable — copiez d'abord .env.example vers .env.`);
    process.exit(1);
  }
  const existing = readFileSync(path, "utf8");
  // The development key is base64, so its "dev-only" marker is not visible in
  // the file: the placeholder has to be recognised by its exact value.
  const PLACEHOLDER_KEYS = '{"1":"ZGV2LW9ubHkta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE="}';
  const current = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("CREDENTIAL_KEYS=") && line.slice("CREDENTIAL_KEYS=".length) !== PLACEHOLDER_KEYS);
  if (current) {
    console.error(
      "CREDENTIAL_KEYS contient déjà une clé de production dans .env.\n" +
        "La remplacer rendrait les clés API déjà stockées définitivement illisibles.\n" +
        "Pour une rotation, ajoutez une version 2 et incrémentez CREDENTIAL_KEY_CURRENT."
    );
    process.exit(1);
  }
  const kept = existing
    .split(/\r?\n/)
    .filter((line) => !SECRET_KEYS.some((key) => line.startsWith(`${key}=`)));
  writeFileSync(path, [...kept, ...assignments, ""].join("\n"), "utf8");
  console.log(`Secrets écrits dans ${path}.`);
}

if (process.argv.includes("--write")) {
  writeEnv(".env");
  process.exit(0);
}

const output = [
  "# ─── Secrets générés — à coller dans .env, à ne jamais versionner ────────────",
  ...assignments,
  "",
  "# Rotation : ajoutez une version 2 dans CREDENTIAL_KEYS, passez",
  "# CREDENTIAL_KEY_CURRENT à 2, et conservez la version 1 tant que des",
  "# identifiants écrits avec elle n'ont pas été rechiffrés.",
  "#",
  "# Remplacer une clé existante rend les identifiants déjà stockés définitivement",
  "# illisibles ; changer le pepper invalide les empreintes de détection de doublon.",
].join("\n");

console.log(output);
