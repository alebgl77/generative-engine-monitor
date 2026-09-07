import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getEnv: vi.fn() }));
vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));

import SignupPage, { dynamic } from "./page";
import SignupForm from "./signup-form";

const privateEnv = {
  NEXTAUTH_SECRET: "private-session-fixture",
  CREDENTIAL_KEYS: { "1": "private-encryption-fixture" },
  DATABASE_URL: "private-database-fixture",
};

beforeEach(() => vi.resetAllMocks());

describe("runtime signup page", () => {
  it("is explicitly dynamic and reads the server setting on each render", () => {
    expect(dynamic).toBe("force-dynamic");
    mocks.getEnv.mockReturnValue({ REGISTRATION_ENABLED: true });
    expect(SignupPage().type).toBe(SignupForm);
    mocks.getEnv.mockReturnValue({ REGISTRATION_ENABLED: false });
    expect(SignupPage().type).not.toBe(SignupForm);
    expect(mocks.getEnv).toHaveBeenCalledTimes(2);
  });

  it("shows the closure and login link without any form when disabled", () => {
    mocks.getEnv.mockReturnValue({ ...privateEnv, REGISTRATION_ENABLED: false });
    const html = renderToStaticMarkup(createElement(SignupPage));
    expect(html).toContain("Inscriptions fermées");
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("private-");
  });

  it("renders the existing form with truthful password requirements when enabled", () => {
    mocks.getEnv.mockReturnValue({ ...privateEnv, REGISTRATION_ENABLED: true });
    const page = SignupPage();
    expect(page.type).toBe(SignupForm);
    expect(page.props).toEqual({});
    const html = renderToStaticMarkup(page);
    expect(html).toContain("<form");
    expect(html).toContain('minLength="10"');
    expect(html).toContain("Au moins 10 caractères, avec une lettre et un chiffre.");
    expect(html).toContain('aria-describedby="password-hint"');
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("Inscriptions fermées");
    expect(html).not.toContain("private-");
  });
});
