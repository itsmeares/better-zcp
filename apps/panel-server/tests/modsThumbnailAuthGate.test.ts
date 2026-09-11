import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleStartApiRequest } from "../http/startApiDispatcher.ts";

const settings = new Map();
const db = { data: { users: [{ id: "u1", username: "admin", role: "admin" }] } };

vi.mock("../database/init.ts", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
  getTrackedMods: vi.fn(async () => []),
  getActiveServer: vi.fn(async () => null),
}));

vi.mock("../utils/paths.ts", () => ({
  getDataPaths: vi.fn(() => ({
    dataDir: "/tmp/mods-thumbnail-auth-gate-test",
    logsDir: "/tmp/mods-thumbnail-auth-gate-test",
  })),
}));

const { default: authService } = await import("../services/auth.ts");
describe("native legacy API authentication carve-outs, no Authorization header", () => {
  beforeAll(async () => {
    settings.clear();
    await authService.init();
  });

  it("GET /api/mods/thumbnail/:workshopId is NOT 401 with no auth header -- the carve-out actually works end-to-end", async () => {
    const res = await handleStartApiRequest(
      new Request("http://panel.test/api/mods/thumbnail/not-a-real-id"),
    );
    expect(res?.status).not.toBe(401);
    expect(res?.status).toBe(400);
  });

  it("GET /api/mods/status (an ordinary gated route) IS still 401 with no auth header -- the carve-out is narrow, not a blanket bypass of the router", async () => {
    const res = await handleStartApiRequest(
      new Request("http://panel.test/api/mods/status"),
    );
    expect(res?.status).toBe(401);
    const body = await res?.json();
    expect(body.code).toBe("AUTH_REQUIRED");
  });

  it("GET /api/map/tiles/:level/:tile (the sibling exemption that already worked) stays not-401 with no auth header", async () => {
    const res = await handleStartApiRequest(
      new Request("http://panel.test/api/map/tiles/999/0_0.jpg"),
    );
    expect(res?.status).not.toBe(401);
    expect(res?.status).toBe(400);
  });
});
