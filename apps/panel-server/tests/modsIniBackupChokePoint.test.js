import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
  getTrackedMods: vi.fn(async () => []),
  addTrackedMod: vi.fn(),
  removeTrackedMod: vi.fn(),
  clearModUpdates: vi.fn(),
  getModPresets: vi.fn(async () => []),
  createModPreset: vi.fn(),
  updateModPreset: vi.fn(),
  deleteModPreset: vi.fn(),
  addIgnoredMod: vi.fn(),
  getIgnoredMods: vi.fn(async () => []),
  removeIgnoredMod: vi.fn(),
  clearAllIgnoredMods: vi.fn(),
  isModIgnored: vi.fn(async () => false),
  getIgnoredModPairs: vi.fn(async () => []),
  addIgnoredModPair: vi.fn(),
  removeIgnoredModPair: vi.fn(),
}));

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");

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

function readBackupFiles(configPath) {
  const backupDir = path.join(configPath, "backups");
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir).filter((f) => f.endsWith(".bak"));
}

describe("mods.js ini-rewriting routes back up the live ini before overwriting it", () => {
  let dataRoot;
  let configPath;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-ini-backup-"));
    configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    fs.writeFileSync(
      path.join(configPath, "TestServer.ini"),
      "Mods=ExistingMod\nWorkshopItems=1111111111\nMap=Muldraugh, KY\n",
    );
    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      isRemote: false,
    });
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("POST /toggle-mod-id backs up the ini before rewriting Mods=", async () => {
    expect(readBackupFiles(configPath)).toHaveLength(0);

    const res = await runRoute("/toggle-mod-id", "post", {
      body: { modId: "NewMod", enabled: true },
    });

    expect(res.getStatusCode()).toBe(200);
    const backups = readBackupFiles(configPath);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^TestServer\.ini\..*\.bak$/);
    const backedUpContent = fs.readFileSync(
      path.join(configPath, "backups", backups[0]),
      "utf-8",
    );
    expect(backedUpContent).toContain("Mods=ExistingMod");
    expect(backedUpContent).not.toContain("NewMod");
  });

  it("POST /write-to-ini backs up the ini before rewriting", async () => {
    const res = await runRoute("/write-to-ini", "post", {
      body: { mods: [{ workshopId: "2222222222", modId: "AnotherMod" }] },
    });

    expect(res.getStatusCode()).toBe(200);
    expect(readBackupFiles(configPath)).toHaveLength(1);
  });

  it("POST /resolve-orphan-workshop (the 19th, previously-uncounted route) backs up the ini before rewriting", async () => {
    const res = await runRoute("/resolve-orphan-workshop", "post", {
      body: { workshopIds: ["1111111111"] },
    });

    expect(res.getStatusCode()).toBe(200);
    expect(readBackupFiles(configPath)).toHaveLength(1);
  });

  it("POST /delete-disk-mod (shared deleteModFromDiskAndIni helper) backs up the ini before rewriting", async () => {
    const res = await runRoute("/delete-disk-mod", "post", {
      body: { workshopId: "1111111111" },
    });

    expect(res.getStatusCode()).toBe(200);
    expect(readBackupFiles(configPath)).toHaveLength(1);
  });

  it("POST /batch-delete-disk-mods backs up the ini before rewriting", async () => {
    const res = await runRoute("/batch-delete-disk-mods", "post", {
      body: { workshopIds: ["1111111111"] },
    });

    expect(res.getStatusCode()).toBe(200);
    expect(readBackupFiles(configPath)).toHaveLength(1);
  });
});

describe("mods.js ini writes: a failed backup warns but never blocks the edit", () => {
  let dataRoot;
  let configPath;
  let copyFileSpy;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-ini-backup-fail-"));
    configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    fs.writeFileSync(
      path.join(configPath, "TestServer.ini"),
      "Mods=ExistingMod\nWorkshopItems=1111111111\nMap=Muldraugh, KY\n",
    );
    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      isRemote: false,
    });
    copyFileSpy = vi
      .spyOn(fs.promises, "copyFile")
      .mockRejectedValue(new Error("ENOSPC: no space left on device"));
  });

  afterEach(() => {
    copyFileSpy.mockRestore();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("POST /toggle-mod-id still applies the edit and reports backupWarning when the backup fails", async () => {
    const res = await runRoute("/toggle-mod-id", "post", {
      body: { modId: "NewMod", enabled: true },
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.success).toBe(true);
    expect(body.backupWarning).toMatch(/could not back up/i);
    expect(body.backupWarning).toMatch(/ENOSPC/);

    const iniContent = fs.readFileSync(
      path.join(configPath, "TestServer.ini"),
      "utf-8",
    );
    expect(iniContent).toMatch(/^Mods=.*NewMod/m);
  });
});
