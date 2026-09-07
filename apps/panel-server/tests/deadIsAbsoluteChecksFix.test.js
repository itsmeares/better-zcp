import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

const getServers = vi.fn(async () => []);
vi.mock("../database/init.ts", () => ({
  getRoleByName: mockGetRoleByName,
  getServers,
}));

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getLayer(router, routePath, method) {
  return router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runRoute(router, routePath, method, req) {
  const res = createResponse();
  const layer = getLayer(router, routePath, method);
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

describe("dead isAbsolute(resolve(x)) checks now reject a relative path before resolving it", () => {
  it("servers.js POST /auto-scan refuses a relative scanPath", async () => {
    const { default: serversRouter } = await import("../routes/servers.ts");
    const res = await runRoute(serversRouter, "/auto-scan", "post", {
      body: { scanPath: "some/relative/dir" },
      user: { role: "admin" },
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Must be an absolute path" }),
    );
  });

  it("servers.js POST /detect refuses a relative dataPath", async () => {
    const { default: serversRouter } = await import("../routes/servers.ts");
    const res = await runRoute(serversRouter, "/detect", "post", {
      body: { dataPath: "some/relative/dir" },
      user: { role: "admin" },
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Must be an absolute path" }),
    );
  });

  it("panelBridge.js POST /install-mod refuses a relative serverLuaPath", async () => {
    const { default: panelBridgeRouter } = await import("../routes/panelBridge.ts");
    const res = await runRoute(panelBridgeRouter, "/install-mod", "post", {
      body: { serverLuaPath: "some/relative/media/lua/server" },
      user: { role: "admin" },
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Must be an absolute path" }),
    );
  });

  it("panelBridge.js POST /install-mod refuses an absolute path outside configured local servers", async () => {
    const { default: panelBridgeRouter } = await import("../routes/panelBridge.ts");
    getServers.mockResolvedValue([]);
    const res = await runRoute(panelBridgeRouter, "/install-mod", "post", {
      body: { serverLuaPath: path.join(os.tmpdir(), "media", "lua", "server") },
      user: { role: "admin" },
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "PANELBRIDGE_SERVER_LUA_PATH_NOT_CONFIGURED",
      }),
    );
  });

  it("panelBridge.js POST /install-mod writes only to a configured local server target", async () => {
    const { default: panelBridgeRouter } = await import("../routes/panelBridge.ts");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-allowlist-"));
    try {
      getServers.mockResolvedValue([{ installPath: root, isRemote: false }]);
      const target = path.join(root, "media", "lua", "server");
      const res = await runRoute(panelBridgeRouter, "/install-mod", "post", {
        body: { serverLuaPath: target },
        user: { role: "admin" },
      });
      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(fs.existsSync(path.join(target, "PanelBridge.lua"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
