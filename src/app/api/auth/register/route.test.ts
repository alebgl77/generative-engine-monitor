import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getEnv: vi.fn(),
  create: vi.fn(),
  hash: vi.fn(),
  ensureBucket: vi.fn(),
  tryConsume: vi.fn(),
  clientIp: vi.fn(),
  forwardedForHeader: vi.fn(),
  recordAudit: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { create: mocks.create } } }));
vi.mock("bcryptjs", () => ({ default: { hash: mocks.hash } }));
vi.mock("@/lib/queue/ratelimit", () => ({ ensureBucket: mocks.ensureBucket, tryConsume: mocks.tryConsume }));
vi.mock("@/lib/net/client-ip", () => ({ clientIp: mocks.clientIp, forwardedForHeader: mocks.forwardedForHeader }));
vi.mock("@/lib/audit", () => ({ AUDIT_ACTIONS: { AUTH_REGISTER: "auth.register" }, recordAudit: mocks.recordAudit }));
vi.mock("@/lib/logger", () => ({ logger: { error: mocks.error } }));
vi.mock("@/lib/auth", () => ({ getServerAuth: vi.fn() }));

import { POST } from "./route";

const validBody = { email: "Person@Example.test", password: "Abcdefghi1", name: " Person " };
const user = { id: "user-1", email: "person@example.test", name: "Person" };

function request(raw = JSON.stringify(validBody)) {
  return new NextRequest("https://example.test/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw,
  });
}

function expectNoRegistrationWork() {
  for (const mock of [mocks.create, mocks.hash, mocks.ensureBucket, mocks.tryConsume,
    mocks.clientIp, mocks.forwardedForHeader, mocks.recordAudit]) {
    expect(mock).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getEnv.mockReturnValue({ REGISTRATION_ENABLED: true });
  mocks.ensureBucket.mockResolvedValue(undefined);
  mocks.tryConsume.mockResolvedValue(true);
  mocks.clientIp.mockReturnValue(null);
  mocks.forwardedForHeader.mockReturnValue(null);
  mocks.hash.mockResolvedValue("password-hash");
  mocks.create.mockResolvedValue(user);
  mocks.recordAudit.mockResolvedValue(undefined);
});

describe("closed registration", () => {
  it.each([JSON.stringify(validBody), "{", "", "null", "{}"])(
    "rejects body %j without reading it or causing side effects",
    async (raw) => {
      mocks.getEnv.mockReturnValue({ REGISTRATION_ENABLED: false });
      const req = request(raw);
      const readBody = vi.spyOn(req, "json");
      const response = await POST(req);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Les inscriptions sont fermées." });
      expect(readBody).not.toHaveBeenCalled();
      expectNoRegistrationWork();
      expect(mocks.error).not.toHaveBeenCalled();
    }
  );

  it("does not depend on a working database or available quota", async () => {
    mocks.getEnv.mockReturnValue({ REGISTRATION_ENABLED: false });
    mocks.ensureBucket.mockRejectedValue(new Error("database unavailable"));
    mocks.tryConsume.mockResolvedValue(false);
    expect((await POST(request())).status).toBe(403);
    expectNoRegistrationWork();
  });

  it("never enables registration after a configuration validation failure", async () => {
    mocks.getEnv.mockImplementation(() => { throw new Error("Invalid environment configuration: fixture-secret"); });
    const req = request();
    const readBody = vi.spyOn(req, "json");
    const response = await POST(req);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Erreur interne" });
    expect(readBody).not.toHaveBeenCalled();
    expectNoRegistrationWork();
  });
});

describe("open registration", () => {
  it("preserves normalized creation, bcrypt cost and audit with a 10-character password", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(user);
    expect(mocks.hash).toHaveBeenCalledWith("Abcdefghi1", 12);
    expect(mocks.create).toHaveBeenCalledWith({
      data: { email: user.email, name: "Person", passwordHash: "password-hash" },
      select: { id: true, email: true, name: true },
    });
    expect(mocks.ensureBucket).toHaveBeenCalledExactlyOnceWith("register:global", 30, 30 / 3600);
    expect(mocks.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      userId: user.id, targetId: user.id, action: "auth.register", ip: null,
    }));
  });

  it.each([undefined, "", "   "])("keeps an absent or blank name as null (%j)", async (name) => {
    expect((await POST(request(JSON.stringify({ ...validBody, name })))).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: null }),
    }));
  });

  it.each([
    { ...validBody, password: "Abcdefgh1" },
    { ...validBody, password: "1234567890" },
    { ...validBody, password: "abcdefghij" },
    { ...validBody, password: "a".repeat(200) + "1" },
    { ...validBody, email: "invalid" },
    { ...validBody, name: "n".repeat(101) },
    {},
  ])("continues rejecting invalid fields before hashing or writes (%j)", async (body) => {
    expect((await POST(request(JSON.stringify(body)))).status).toBe(400);
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("continues returning 400 for malformed JSON when enabled", async () => {
    expect((await POST(request("{"))).status).toBe(400);
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("preserves the generic duplicate-account response", async () => {
    mocks.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("email duplicate", {
      code: "P2002", clientVersion: "test", meta: { target: ["email"] },
    }));
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Inscription impossible avec ces informations." });
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("keeps the global quota first and does not parse a throttled body", async () => {
    mocks.tryConsume.mockResolvedValue(false);
    const req = request("{");
    const readBody = vi.spyOn(req, "json");
    expect((await POST(req)).status).toBe(429);
    expect(mocks.ensureBucket).toHaveBeenCalledExactlyOnceWith("register:global", 30, 30 / 3600);
    expect(mocks.clientIp).not.toHaveBeenCalled();
    expect(readBody).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("still enforces the trusted-address quota after the global quota", async () => {
    mocks.clientIp.mockReturnValue("192.0.2.1");
    mocks.tryConsume.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const req = request();
    const readBody = vi.spyOn(req, "json");
    expect((await POST(req)).status).toBe(429);
    expect(mocks.ensureBucket.mock.calls).toEqual([
      ["register:global", 30, 30 / 3600], ["register:192.0.2.1", 5, 5 / 3600],
    ]);
    expect(mocks.tryConsume.mock.calls).toEqual([["register:global"], ["register:192.0.2.1"]]);
    expect(readBody).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
