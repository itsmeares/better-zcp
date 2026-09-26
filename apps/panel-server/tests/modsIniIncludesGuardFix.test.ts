import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "fs";
import os from "os";
import path from "path";


vi.mock("../database/init.ts", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
}));

const { getActiveServer, getSetting } = await import("../database/init.ts");
const { default: router } = await import("../routes/mods.ts");

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

describe("POST /toggle-mod-id: the requested change lands even when a free-text field mentions \"Mods=\"", () => {
  let dataRoot;
  let iniPath;

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("a real Mods= line present: the new mod ID is actually written, not silently dropped", async () => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-includes-guard-"));
    const configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    iniPath = path.join(configPath, "TestServer.ini");
    fs.writeFileSync(
      iniPath,
      'ServerWelcomeMessage=Check our Mods=folder for the full list!\nMods=OldMod\nWorkshopItems=\n',
    );
    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
    });

    const res = await runRoute("/toggle-mod-id", "post", {
      body: { modId: "NewMod", enabled: true },
    });

    expect(res.getStatusCode()).toBe(200);
    const content = fs.readFileSync(iniPath, "utf-8");
    const modsLine = content.match(/^Mods=(.*)$/m)?.[1] || "";
    expect(modsLine.split(";")).toEqual(
      expect.arrayContaining(["OldMod", "NewMod"]),
    );
    expect(content).toContain("ServerWelcomeMessage=Check our Mods=folder for the full list!");
  });

  it("NO real Mods= line, only the free-text mention: the code appends one instead of silently no-opping", async () => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-includes-guard-append-"));
    const configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    iniPath = path.join(configPath, "TestServer.ini");
    fs.writeFileSync(
      iniPath,
      "ServerWelcomeMessage=Check our Mods=folder for the full list!\nWorkshopItems=\n",
    );
    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
    });

    const res = await runRoute("/toggle-mod-id", "post", {
      body: { modId: "NewMod", enabled: true },
    });

    expect(res.getStatusCode()).toBe(200);
    const content = fs.readFileSync(iniPath, "utf-8");
    const modsLine = content.match(/^Mods=(.*)$/m)?.[1];
    expect(modsLine, "no real Mods= line was ever written -- the change was silently dropped").toBeDefined();
    expect(modsLine.split(";")).toContain("NewMod");
  });

  it("does not write an old server's INI when the active profile has no config path", async () => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-profile-path-"));
    const oldConfigPath = path.join(dataRoot, "Server");
    fs.mkdirSync(oldConfigPath);
    iniPath = path.join(oldConfigPath, "OldServer.ini");
    fs.writeFileSync(iniPath, "Mods=OldMod\n");
    getActiveServer.mockReset().mockResolvedValue({ id: "new", serverName: "NewServer" });
    getSetting.mockReset().mockImplementation(async (key) =>
      key === "serverConfigPath" ? oldConfigPath : "OldServer",
    );

    const res = await runRoute("/toggle-mod-id", "post", {
      body: { modId: "NewMod", enabled: true },
    });

    expect(res.getStatusCode()).toBe(400);
    expect(fs.readFileSync(iniPath, "utf8")).toBe("Mods=OldMod\n");
    expect(getSetting).not.toHaveBeenCalled();
  });

  it("uses one profile snapshot for the INI path and server name", async () => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-profile-switch-"));
    const profiles = ["First", "Second"].map((name) => {
      const serverConfigPath = path.join(dataRoot, name);
      fs.mkdirSync(serverConfigPath);
      fs.writeFileSync(path.join(serverConfigPath, `${name}.ini`), "Mods=Existing\n");
      return { id: name, serverConfigPath, serverName: name };
    });
    getActiveServer.mockReset()
      .mockResolvedValueOnce(profiles[0])
      .mockResolvedValue(profiles[1]);

    const res = await runRoute("/toggle-mod-id", "post", {
      body: { modId: "NewMod", enabled: true },
    });

    expect(res.getStatusCode()).toBe(200);
    expect(getActiveServer).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(profiles[0].serverConfigPath, "First.ini"), "utf8"))
      .toContain("Mods=Existing;NewMod");
    expect(fs.readFileSync(path.join(profiles[1].serverConfigPath, "Second.ini"), "utf8"))
      .toBe("Mods=Existing\n");
  });
});
