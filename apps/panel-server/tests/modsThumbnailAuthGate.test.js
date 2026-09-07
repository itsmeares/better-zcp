import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import express from "express";

const settings = new Map();
const db = { data: { users: [{ id: "u1", username: "admin", role: "admin" }] } };

vi.mock("../database/init.js", () => ({
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

const { default: authService } = await import("../services/auth.js");
const { default: modsRouter } = await import("../routes/mods.js");
const { default: mapProxyRouter } = await import("../routes/mapProxy.ts");

describe("real authService.middleware() + real mods.js/mapProxy.ts routers, no Authorization header", () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    settings.clear();
    await authService.init();

    const app = express();
    app.use(authService.middleware());
    app.use("/api/mods", modsRouter);
    app.use("/api/map", mapProxyRouter);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("GET /api/mods/thumbnail/:workshopId is NOT 401 with no auth header -- the carve-out actually works end-to-end", async () => {
    const res = await fetch(`${baseUrl}/api/mods/thumbnail/not-a-real-id`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400);
  });

  it("GET /api/mods/status (an ordinary gated route) IS still 401 with no auth header -- the carve-out is narrow, not a blanket bypass of the router", async () => {
    const res = await fetch(`${baseUrl}/api/mods/status`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("AUTH_REQUIRED");
  });

  it("GET /api/map/tiles/:level/:tile (the sibling exemption that already worked) stays not-401 with no auth header", async () => {
    const res = await fetch(`${baseUrl}/api/map/tiles/999/0_0.jpg`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400);
  });
});
