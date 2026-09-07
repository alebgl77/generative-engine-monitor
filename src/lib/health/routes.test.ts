import { beforeEach, expect, it, vi } from "vitest";
import { GET as live } from "@/app/api/health/live/route";
import { GET as ready } from "@/app/api/health/ready/route";
import { isReady } from "./readiness";

vi.mock("./readiness", () => ({ isReady: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it("liveness remains minimal and independent of the database", async () => {
  const response = live();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(isReady).not.toHaveBeenCalled();
});

it.each([true, false])("readiness exposes only status when ready=%s", async (healthy) => {
  vi.mocked(isReady).mockResolvedValue(healthy);
  const response = await ready();
  expect(response.status).toBe(healthy ? 200 : 503);
  expect(await response.json()).toEqual({ status: healthy ? "ready" : "unavailable" });
  expect(response.headers.get("cache-control")).toBe("no-store");
});
