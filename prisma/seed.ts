import "dotenv/config";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { encryptCredential } from "../src/lib/crypto/credentials";
import { getEnv, modelFor } from "../src/lib/env";

const prisma = new PrismaClient();

/**
 * Providers are seeded with their capabilities, because run planning reads them
 * to decide which cells exist. Perplexity is search-native: asking it to answer
 * without retrieval is meaningless, so it declares no parametric mode.
 *
 * Rate limits are conservative starting points, enforced by a token bucket
 * shared across worker processes.
 */
const PROVIDERS = [
  { code: "openai", label: "OpenAI ChatGPT", parametric: true, grounded: true, rpm: 60, concurrency: 4 },
  { code: "claude", label: "Anthropic Claude", parametric: true, grounded: true, rpm: 50, concurrency: 4 },
  { code: "gemini", label: "Google Gemini", parametric: true, grounded: true, rpm: 60, concurrency: 4 },
  { code: "perplexity", label: "Perplexity", parametric: false, grounded: true, rpm: 50, concurrency: 3 },
  { code: "mock", label: "Mock (démo)", parametric: true, grounded: true, rpm: 100_000, concurrency: 8 },
] as const;

const DEMO_QUERIES = [
  "Quel est le meilleur CRM pour une PME française ?",
  "Comparatif des logiciels CRM en 2026",
  "Quel CRM choisir pour une équipe commerciale de 10 personnes ?",
  "CRM français conforme au RGPD : quelles solutions ?",
  "Alternatives à Salesforce pour une petite entreprise",
  "Quel CRM s'intègre le mieux avec les outils de facturation français ?",
  "CRM avec le meilleur rapport qualité-prix pour une startup",
  "Comment choisir un CRM pour une entreprise B2B ?",
];

const DEMO_COMPETITORS = [
  { name: "Salesforce", domain: "salesforce.com", aliases: ["Sales Cloud"] },
  { name: "HubSpot", domain: "hubspot.com", aliases: ["HubSpot CRM"] },
  { name: "Pipedrive", domain: "pipedrive.com", aliases: [] as string[] },
  { name: "Zoho CRM", domain: "zoho.com", aliases: ["Zoho"] },
  { name: "Axonaut", domain: "axonaut.com", aliases: [] as string[] },
];

async function seedProviders() {
  for (const p of PROVIDERS) {
    const data = {
      label: p.label,
      supportsParametric: p.parametric,
      supportsGrounded: p.grounded,
      defaultModel: modelFor(p.code),
      rpmLimit: p.rpm,
      maxConcurrency: p.concurrency,
    };
    await prisma.provider.upsert({
      where: { code: p.code },
      update: data,
      create: { code: p.code, ...data },
    });

    const key = `provider:${p.code}`;
    const refillPerSec = p.rpm / 60;
    await prisma.rateLimitBucket.upsert({
      where: { key },
      update: { capacity: p.rpm, refillPerSec },
      create: { key, capacity: p.rpm, tokens: p.rpm, refillPerSec },
    });
  }
  console.log(`Seeded ${PROVIDERS.length} providers and their rate-limit buckets.`);
}

async function seedDemo() {
  const email = "demo@gem.local";
  // Generated per seed rather than hardcoded: a fixed demo password published in
  // a public README is a working credential on every deployment that seeds.
  const password = randomBytes(12).toString("base64url");
  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash },
    create: { email, name: "Compte de démonstration", passwordHash },
  });

  const existing = await prisma.project.findFirst({
    where: { userId: user.id, name: "Démo — CRM français" },
  });

  const project =
    existing ??
    (await prisma.project.create({
      data: {
        userId: user.id,
        name: "Démo — CRM français",
        domain: "sellsy.com",
        targetCountry: "FR",
        targetLanguage: "fr",
      },
    }));

  if (!existing) {
    // Chosen from the roster the mock engine names in its fixtures: a tracked
    // brand the fixtures never mention would open the dashboard on zeros and
    // read as a broken install rather than as an absent brand.
    await prisma.brand.create({
      data: {
        projectId: project.id,
        name: "Sellsy",
        domain: "sellsy.com",
        aliases: ["Sellsy CRM"],
      },
    });
    await prisma.competitor.createMany({
      data: DEMO_COMPETITORS.map((c) => ({ projectId: project.id, ...c })),
    });
    await prisma.query.createMany({
      data: DEMO_QUERIES.map((text) => ({ projectId: project.id, text })),
    });
  }

  // The mock provider needs no real key, but its credential still goes through
  // the encrypted path so the demo exercises the production code path.
  const mock = await prisma.provider.findUnique({ where: { code: "mock" } });
  if (mock) {
    const sealed = encryptCredential("mock-key", { userId: user.id, providerId: mock.id });
    await prisma.providerCredential.upsert({
      where: { userId_providerId: { userId: user.id, providerId: mock.id } },
      update: { ...sealed, isValid: true, lastValidatedAt: new Date() },
      create: {
        userId: user.id,
        providerId: mock.id,
        ...sealed,
        isValid: true,
        lastValidatedAt: new Date(),
      },
    });
  }

  console.log("\n─────────────────────────────────────────────");
  console.log("  Compte de démonstration (affiché une seule fois)");
  console.log(`  email    ${email}`);
  console.log(`  mot de passe ${password}`);
  console.log("─────────────────────────────────────────────\n");
}

async function main() {
  const env = getEnv();
  await seedProviders();

  if (env.SEED_DEMO) {
    await seedDemo();
  } else {
    console.log("SEED_DEMO=false — demo data skipped.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
