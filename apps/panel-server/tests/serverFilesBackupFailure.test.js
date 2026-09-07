import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


const getActiveServer = vi.fn();
const getAllSettings = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings,
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

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function runHandler(routePath, method, req) {
  const res = createResponse();
  await getHandler(routePath, method)(req, res, () => {});
  return res;
}

function sabotageBackupDir(configPath) {
  fs.writeFileSync(path.join(configPath, "backups"), "not a directory");
}

describe("createBackup() itself: distinguishes no-source from a real failure", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-fail-unit-"));
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue({
      serverConfigPath: tmpDir,
      serverName: "TestServer",
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns backedUp:false, reason:no-source when the file doesn't exist -- benign, not a failure", async () => {
    const res = await runHandler("/ini", "put", {
      body: { settings: { PublicName: "Test" } },
    });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.backupWarning).toBeUndefined();
  });

  it("returns 400 for a missing INI-save body", async () => {
    const res = await runHandler("/ini", "put", { body: null });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INI_SETTINGS_REQUIRED" }),
    );
  });

  it("a real backup failure on an existing file produces backedUp:false, reason:failed with the actual error", async () => {
    const iniPath = path.join(tmpDir, "TestServer.ini");
    fs.writeFileSync(iniPath, "PublicName=Old\n");
    sabotageBackupDir(tmpDir);

    const res = await runHandler("/ini", "put", {
      body: { settings: { PublicName: "New" } },
    });

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("PublicName=New");
    const payload = res.json.mock.calls[0][0];
    expect(payload.backupWarning).toMatch(/could not back up/i);
  });
});

describe("PUT /ini (an 'ordinary edit' site): backup failure never blocks the edit, but is never hidden either", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-fail-ini-"));
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue({
      serverConfigPath: tmpDir,
      serverName: "TestServer",
    });
    fs.writeFileSync(path.join(tmpDir, "TestServer.ini"), "PublicName=Old\n");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a SUCCESSFUL backup still lets the edit through and carries no warning", async () => {
    const res = await runHandler("/ini", "put", {
      body: { settings: { PublicName: "New" } },
    });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.backupWarning).toBeUndefined();
    const backups = fs.readdirSync(path.join(tmpDir, "backups"));
    expect(backups.some((f) => f.startsWith("TestServer.ini."))).toBe(true);
  });

  it("a FAILED backup still lets the edit through, but says so", async () => {
    sabotageBackupDir(tmpDir);
    const res = await runHandler("/ini", "put", {
      body: { settings: { PublicName: "New" } },
    });
    expect(res.status).not.toHaveBeenCalledWith(500);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.backupWarning).toMatch(/could not back up/i);
    expect(
      fs.readFileSync(path.join(tmpDir, "TestServer.ini"), "utf-8"),
    ).toContain("PublicName=New");
  });
});

describe("POST /sandbox/repair (the ONE unrecoverable-operation site): refuses to repair when the backup fails", () => {
  let tmpDir;

  function corruptSandbox() {
    const content = [
      "Vehicles = {",
      "    OrphanKey = true",
      "        NestedKey = 5,",
      "    }",
      "}",
    ].join("\n");
    fs.writeFileSync(
      path.join(tmpDir, "TestServer_SandboxVars.lua"),
      content,
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-fail-repair-"));
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue({
      serverConfigPath: tmpDir,
      serverName: "TestServer",
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a SUCCESSFUL backup lets the repair proceed and names the real backup in the message", async () => {
    corruptSandbox();
    const res = await runHandler("/sandbox/repair", "post", {});

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, repaired: true }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.message).toMatch(/backup of the broken file was saved first/i);
    const backups = fs.readdirSync(path.join(tmpDir, "backups"));
    expect(
      backups.some((f) => f.startsWith("TestServer_SandboxVars.lua.")),
    ).toBe(true);
  });

  it("a FAILED backup refuses the repair outright -- the corrupted file is left completely untouched", async () => {
    corruptSandbox();
    const originalContent = fs.readFileSync(
      path.join(tmpDir, "TestServer_SandboxVars.lua"),
      "utf-8",
    );
    sabotageBackupDir(tmpDir);

    const res = await runHandler("/sandbox/repair", "post", {});

    expect(res.status).toHaveBeenCalledWith(422);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/could not back up/i);
    expect(payload.code).toBe("SANDBOX_REPAIR_BACKUP_FAILED");
    expect(payload.params).toEqual({ reason: expect.any(String) });
    expect(payload.params.reason.length).toBeGreaterThan(0);
    expect(
      fs.readFileSync(path.join(tmpDir, "TestServer_SandboxVars.lua"), "utf-8"),
    ).toBe(originalContent);
  });
});
