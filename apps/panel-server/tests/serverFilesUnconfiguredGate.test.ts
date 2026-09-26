import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "fs";
import os from "os";
import path from "path";

const { getActiveServer } = vi.hoisted(() => ({
  getActiveServer: vi.fn(),
}));

vi.mock("../database/init.ts", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
}));

const { default: router } = await import("../routes/serverFiles.ts");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getGateMiddleware() {
  const nonRouteLayers = router.stack.filter((entry) => !entry.route);
  return nonRouteLayers[0].handle;
}

function getProfileGuardMiddleware() {
  return router.stack.filter((entry) => !entry.route)[1].handle;
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

    await getGateMiddleware()(
      { path: "/paths", method: "GET" },
      response,
      next,
    );

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

    await getGateMiddleware()(
      { path: "/paths", method: "GET" },
      response,
      next,
    );

    expect(next).toHaveBeenCalledWith();
    expect(response.status).not.toHaveBeenCalled();
  });

  it("the gate never even reaches the file the route handler would read — GET /paths itself would invent nothing anyway, but the gate stops it first", async () => {
    getActiveServer.mockResolvedValue(null);
    const response = createResponse();
    const next = vi.fn();

    await getGateMiddleware()(
      { path: "/paths", method: "GET" },
      response,
      next,
    );

    expect(response.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ serverName: "servertest" }),
    );
  });
});

describe("server-files router: a configured server still resolves and reads real data", () => {
  let configDir;

  beforeEach(() => {
    getActiveServer.mockReset();
    configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "serverfiles-configured-"),
    );
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

describe("server-files router: a save stays on the loaded profile", () => {
  let dataRoot;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "serverfiles-profile-"));
    getActiveServer.mockReset();
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("rejects a stale profile ID before writing either server, while sparse edits preserve another INI setting", async () => {
    const servers = ["A", "B"].map((name) => {
      const serverConfigPath = path.join(dataRoot, name);
      fs.mkdirSync(serverConfigPath);
      const iniPath = path.join(serverConfigPath, `${name}.ini`);
      fs.writeFileSync(iniPath, "Mods=Original\nPublicName=Old\n");
      return { id: name, serverName: name, serverConfigPath, iniPath };
    });
    getActiveServer.mockResolvedValue(servers[0]);
    const loadedRequest = { path: "/paths", method: "GET", body: {} };
    await getGateMiddleware()(loadedRequest, createResponse(), vi.fn());
    const loadedResponse = createResponse();
    await getRouteHandler("get", "/paths")(loadedRequest, loadedResponse);
    const loadedId = loadedResponse.json.mock.calls[0][0].serverId;
    expect(loadedId).toBe("A");

    getActiveServer.mockResolvedValue(servers[1]);
    const staleRequest = {
      path: "/ini",
      method: "PUT",
      body: { expectedServerId: loadedId, settings: { PublicName: "New" } },
    };
    await getGateMiddleware()(staleRequest, createResponse(), vi.fn());
    const staleResponse = createResponse();
    const staleNext = vi.fn();
    getProfileGuardMiddleware()(staleRequest, staleResponse, staleNext);
    expect(staleResponse.status).toHaveBeenCalledWith(409);
    expect(staleResponse.json).toHaveBeenCalledWith(expect.objectContaining({ code: "SERVER_PROFILE_CHANGED" }));
    expect(staleNext).not.toHaveBeenCalled();
    expect(fs.readFileSync(servers[0].iniPath, "utf-8")).toContain("PublicName=Old");
    expect(fs.readFileSync(servers[1].iniPath, "utf-8")).toContain("PublicName=Old");

    getActiveServer.mockResolvedValue(servers[0]);
    fs.writeFileSync(servers[0].iniPath, "Mods=ChangedInModsPage\nPublicName=Old\n");
    const currentRequest = { ...staleRequest };
    await getGateMiddleware()(currentRequest, createResponse(), vi.fn());
    const currentNext = vi.fn();
    getProfileGuardMiddleware()(currentRequest, createResponse(), currentNext);
    expect(currentNext).toHaveBeenCalled();
    const savedResponse = createResponse();
    await getRouteHandler("put", "/ini")(currentRequest, savedResponse);
    expect(savedResponse.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(fs.readFileSync(servers[0].iniPath, "utf-8")).toContain("Mods=ChangedInModsPage");
    expect(fs.readFileSync(servers[0].iniPath, "utf-8")).toContain("PublicName=New");
  });
});
