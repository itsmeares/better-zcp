import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { handleApiRequest } from "../http/apiDispatcher.ts";

const settings = new Map();
const db = { data: { users: [{ id: "u1", username: "admin", role: "admin" }] } };

vi.mock("../database/init.ts", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getAdmin: async () => structuredClone(db.data.users[0] ?? null),
  createAdmin: async user => { db.data.users.push(structuredClone(user)); },
  saveAdmin: async user => { db.data.users[0] = structuredClone(user); },
  getTrackedMods: vi.fn(async () => []),
  getCurrentServer: vi.fn(async () => null),
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
    const res = await handleApiRequest(
      new Request("http://panel.test/api/mods/thumbnail/not-a-real-id"),
    );
    expect(res?.status).not.toBe(401);
    expect(res?.status).toBe(400);
  });

  it("GET /api/mods/status (an ordinary gated route) IS still 401 with no auth header -- the carve-out is narrow, not a blanket bypass of the router", async () => {
    const res = await handleApiRequest(
      new Request("http://panel.test/api/mods/status"),
    );
    expect(res?.status).toBe(401);
    const body = await res?.json();
    expect(body.code).toBe("AUTH_REQUIRED");
  });

  it("does not accept a valid bearer token from the query string", async () => {
    const token = authService.generateAccessToken(db.data.users[0]);
    const queryTokenResponse = await handleApiRequest(
      new Request(
        `http://panel.test/api/mods/status?token=${encodeURIComponent(token)}`,
      ),
    );
    expect(queryTokenResponse?.status).toBe(401);
    expect(await queryTokenResponse?.json()).toMatchObject({
      code: "AUTH_REQUIRED",
    });

    const bearerResponse = await handleApiRequest(
      new Request("http://panel.test/api/mods/status", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(bearerResponse?.status).toBe(400);
  });

  it("requires authentication for map metadata", async () => {
    const res = await handleApiRequest(
      new Request("http://panel.test/api/map/manifest"),
    );
    expect(res?.status).toBe(401);
  });
});
