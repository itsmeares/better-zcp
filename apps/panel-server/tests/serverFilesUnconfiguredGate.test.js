import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { getActiveServer } = vi.hoisted(() => ({
  getActiveServer: vi.fn(),
}));

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
}));

vi.mock("../services/remoteConfigFiles.ts", () => ({
  SFTP_CONFIG_PATH_KEY: "panelBridgeSftpConfigPath",
  acquireMirrorLock: vi.fn(),
  beginRemoteConfigSession: vi.fn(),
  getMirrorPath: vi.fn(),
  isRemoteConfigConfigured: vi.fn(() => false),
  pushRemoteConfigFiles: vi.fn(),
  validateRemoteConfigTransport: vi.fn(),
}));

const { default: router } = await import("../routes/serverFiles.ts");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getGateMiddleware() {
  const nonRouteLayers = router.stack.filter((entry) => !entry.route);
  return nonRouteLayers[1].handle;
}

function getRouteHandler(method, routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe("server-files router: unconfigured-server gate", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
  });

  it("returns 404 'No active server configured' — same shape as GET /api/servers/active — instead of calling next()", async () => {
    getActiveServer.mockResolvedValue(null);
    const response = createResponse();
    const next = vi.fn();

    await getGateMiddleware()({ path: "/paths", method: "GET" }, response, next);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      error: "No active server configured",
      code: "SERVER_NOT_CONFIGURED",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() with no error when a server is genuinely configured", async () => {
    getActiveServer.mockResolvedValue({ serverConfigPath: "/srv/pz/Server" });
    const response = createResponse();
    const next = vi.fn();

    await getGateMiddleware()({ path: "/paths", method: "GET" }, response, next);

    expect(next).toHaveBeenCalledWith();
    expect(response.status).not.toHaveBeenCalled();
  });

  it("the gate never even reaches the file the route handler would read — GET /paths itself would invent nothing anyway, but the gate stops it first", async () => {
    getActiveServer.mockResolvedValue(null);
    const response = createResponse();
    const next = vi.fn();

    await getGateMiddleware()({ path: "/paths", method: "GET" }, response, next);

    expect(response.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ serverName: "servertest" }),
    );
  });
});

describe("server-files router: a configured server still resolves and reads real data", () => {
  let configDir;

  beforeEach(() => {
    getActiveServer.mockReset();
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "serverfiles-configured-"));
    fs.writeFileSync(
      path.join(configDir, "RealServer_spawnpoints.lua"),
      "-- real file",
    );
    getActiveServer.mockResolvedValue({
      serverName: "RealServer",
      serverConfigPath: configDir,
    });
  });

  it("GET /paths reports the real configured server's real paths, not an invented one", async () => {
    const response = createResponse();
    await getRouteHandler("get", "/paths")({}, response);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: configDir,
        serverName: "RealServer",
        exists: expect.objectContaining({ spawnpoints: true }),
      }),
    );
  });
});
