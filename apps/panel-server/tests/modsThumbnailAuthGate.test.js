import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import express from "express";

// conv-mods-thumbnails / 9c6ce2e (shipped in v1.2.0): routes/mods.js gates
// its whole router with requirePermission("mods.manage"), which 401s on a
// missing req.user *before* it ever looks at capability -- and
// services/auth.js deliberately never sets req.user for
// "/api/mods/thumbnail/", since it's loaded via <img> tags that can't carry
// an Authorization header. The two files used to agree; 9c6ce2e's
// router-level gate broke that agreement silently, and the route 401'd for
// every request on every 1.2.0+ install, authenticated or not.
//
// This hits the REAL wiring -- the actual authService.middleware() in front
// of the actual mods.js and mapProxy.js routers, over a real HTTP request --
// with no Authorization header, exactly as a browser <img> tag sends one.
// A route-level-only harness (grab the handler off router.stack, call it
// directly) would not have caught this, because it skips router.use()
// entirely -- that's exactly what modThumbnailResolution.test.js's harness
// does, which is why this coverage lives in its own file instead.
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

vi.mock("../utils/paths.js", () => ({
  getDataPaths: vi.fn(() => ({
    dataDir: "/tmp/mods-thumbnail-auth-gate-test",
    logsDir: "/tmp/mods-thumbnail-auth-gate-test",
  })),
}));

const { default: authService } = await import("../services/auth.js");
const { default: modsRouter } = await import("../routes/mods.js");
const { default: mapProxyRouter } = await import("../routes/mapProxy.js");

describe("real authService.middleware() + real mods.js/mapProxy.js routers, no Authorization header", () => {
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
    // Deliberately-invalid id: the route rejects it with its own 400 before
    // touching the DB or network, so this only proves the request reached
    // the real handler at all, unauthenticated -- which is the whole point.
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
    // Invalid level, same trick as above: reaches the route's own 400.
    const res = await fetch(`${baseUrl}/api/map/tiles/999/0_0.jpg`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400);
  });
});
