import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { findDuplicateIniKeys } from "../utils/iniDuplicateKeys.ts";


vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
  getSetting: vi.fn(async () => null),
}));

describe("findDuplicateIniKeys (pure function)", () => {
  it("returns nothing for a well-formed file", () => {
    expect(findDuplicateIniKeys("PublicName=Test\nMods=A;B\nMaxPlayers=16\n")).toEqual([]);
  });

  it("finds a key duplicated as two real line-anchored assignments", () => {
    expect(
      findDuplicateIniKeys("Mods=A;B\nMaxPlayers=16\nMods=C;D\n"),
    ).toEqual([{ key: "Mods", count: 2 }]);
  });

  it("finds multiple duplicated keys independently, each with its own count", () => {
    const content = "Mods=A\nWorkshopItems=1\nMods=B\nWorkshopItems=2\nWorkshopItems=3\n";
    expect(findDuplicateIniKeys(content)).toEqual([
      { key: "Mods", count: 2 },
      { key: "WorkshopItems", count: 3 },
    ]);
  });

  it("does NOT flag a key name mentioned inside another field's free-text value", () => {
    expect(
      findDuplicateIniKeys('ServerWelcomeMessage=Check our Mods=folder for the full list!\nMods=A\n'),
    ).toEqual([]);
  });

  it("does NOT flag a key name mentioned inside a comment line", () => {
    expect(
      findDuplicateIniKeys("; Mods=old value, disabled\n# Mods=also disabled\nMods=A\n"),
    ).toEqual([]);
  });

  it("tolerates leading whitespace and CRLF, same as parseIni()'s own tolerance", () => {
    expect(findDuplicateIniKeys("  Mods=A\r\nMods=B\r\n")).toEqual([{ key: "Mods", count: 2 }]);
  });

  it("returns [] for non-string/empty input instead of throwing", () => {
    expect(findDuplicateIniKeys("")).toEqual([]);
    expect(findDuplicateIniKeys(null)).toEqual([]);
    expect(findDuplicateIniKeys(undefined)).toEqual([]);
  });
});

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

async function invokeLastHandler(router, routePath, method, req) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  const res = createResponse();
  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);
  return res;
}

describe("GET /server-files/ini and GET /mods/validate-config surface a real duplicated key", () => {
  let dataRoot;

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("serverFiles.ts's GET /ini reports duplicateKeys for a real duplicated file", async () => {
    vi.resetModules();
    const { getActiveServer } = await import("../database/init.js");
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ini-dup-serverfiles-"));
    const configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    fs.writeFileSync(
      path.join(configPath, "TestServer.ini"),
      "PublicName=Block One\nMods=FirstBlockMods\nPublicName=Block Two\nMods=SecondBlockMods\n",
    );
    getActiveServer.mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      isRemote: false,
    });

    const { default: router } = await import("../routes/serverFiles.ts");
    const res = await invokeLastHandler(router, "/ini", "get", {});

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.duplicateKeys).toEqual(
      expect.arrayContaining([
        { key: "PublicName", count: 2 },
        { key: "Mods", count: 2 },
      ]),
    );
    expect(body.settings.Mods).toBe("SecondBlockMods");
  });

  it("mods.js's GET /validate-config reports a duplicate_key error for a real duplicated file, without blocking the request", async () => {
    vi.resetModules();
    const { getActiveServer } = await import("../database/init.js");
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ini-dup-mods-"));
    const configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    fs.writeFileSync(
      path.join(configPath, "TestServer.ini"),
      "Mods=FirstBlockMods\nWorkshopItems=111\nMods=SecondBlockMods\nWorkshopItems=222\n",
    );
    getActiveServer.mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      isRemote: false,
    });

    const { default: router } = await import("../routes/mods.js");
    const res = await invokeLastHandler(router, "/validate-config", "get", {});

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "duplicate_key", key: "Mods", count: 2 }),
        expect.objectContaining({ type: "duplicate_key", key: "WorkshopItems", count: 2 }),
      ]),
    );
    expect(body.valid).toBe(false);
  });

  it("mods.js's GET /current-config -- what the Mods page actually loads on open -- reports duplicateKeys too", async () => {
    vi.resetModules();
    const { getActiveServer } = await import("../database/init.js");
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ini-dup-current-config-"));
    const configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    fs.writeFileSync(
      path.join(configPath, "TestServer.ini"),
      "Mods=FirstBlockMods\nWorkshopItems=111\nMods=SecondBlockMods\nWorkshopItems=222\n",
    );
    getActiveServer.mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      isRemote: false,
    });

    const { default: router } = await import("../routes/mods.js");
    const res = await invokeLastHandler(router, "/current-config", "get", {});

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.configured).toBe(true);
    expect(body.duplicateKeys).toEqual(
      expect.arrayContaining([
        { key: "Mods", count: 2 },
        { key: "WorkshopItems", count: 2 },
      ]),
    );
    expect(body.modIds).toEqual(["FirstBlockMods"]);
  });
});
