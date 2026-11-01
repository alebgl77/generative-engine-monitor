import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), create: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/auth", () => ({ getServerAuth: mocks.auth }));
vi.mock("@/lib/prisma", () => ({ prisma: { project: { create: mocks.create } } }));
vi.mock("@/lib/logger", () => ({ logger: { error: mocks.error } }));
vi.mock("@/lib/net/client-ip", () => ({ clientIp: () => null }));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("https://example.test/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
  mocks.create.mockImplementation(async ({ data }) => ({
    id: "project-1", ...data, activeScoringVersion: "v3",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    _count: { brands: 0, competitors: 0, queries: 0 }, runs: [],
  }));
});

describe("project request validation", () => {
  it("validates and transforms defaults while preserving the public response", async () => {
    const response = await POST(request({ name: " Example ", unexpected: true }));
    expect(response.status).toBe(201);
    expect(mocks.create.mock.calls[0][0].data).toEqual({
      userId: "user-1", name: "Example", domain: null, targetCountry: "FR",
      targetLanguage: "fr", repetitions: 3, samplingModes: ["PARAMETRIC", "GROUNDED"],
    });
    expect(await response.json()).toEqual({
      id: "project-1", name: "Example", domain: null, targetCountry: "FR",
      targetLanguage: "fr", repetitions: 3, samplingModes: ["PARAMETRIC", "GROUNDED"],
      activeScoringVersion: "v3", createdAt: "2026-01-01T00:00:00.000Z",
      counts: { brands: 0, competitors: 0, queries: 0 }, lastRunAt: null,
    });
  });

  it("normalizes supplied values and deduplicates sampling modes", async () => {
    const response = await POST(request({
      name: " Example ", domain: " HTTPS://Example.COM/path ", targetCountry: " gb ",
      targetLanguage: " EN ", repetitions: 2, samplingModes: ["GROUNDED", "GROUNDED"],
    }));
    expect(response.status).toBe(201);
    expect(mocks.create.mock.calls[0][0].data).toMatchObject({
      name: "Example", domain: "example.com", targetCountry: "GB",
      targetLanguage: "en", repetitions: 2, samplingModes: ["GROUNDED"],
    });
  });

  it.each([
    [{ name: " " }, "name: nom requis"],
    [{ name: "Example", domain: "invalid_host" }, "domain: doit ressembler à un nom de domaine (exemple.fr)"],
    [{ name: "Example", targetCountry: "FRA" }, "targetCountry: code pays ISO à 2 lettres attendu"],
    [{ name: "Example", repetitions: 1.5 }, "repetitions: nombre entier attendu"],
    [{ name: "Example", repetitions: 0 }, "repetitions: au moins 1 répétition"],
    [{ name: "Example", samplingModes: [] }, "samplingModes: au moins un mode d'échantillonnage"],
  ])("preserves the French validation response for %j", async (body, detail) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: `Requête invalide — ${detail}` });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before any project write", async () => {
    const response = await POST(request("{"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Corps de requête JSON invalide" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("keeps missing-field failures as 400 with the same error envelope and field path", async () => {
    const response = await POST(request({}));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringMatching(/^Requête invalide — name:/) });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not weaken authentication during validation", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await POST(request({ name: "Example" }));
    expect(response.status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
