import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


let spawnImpl;
vi.mock("child_process", () => ({
  spawn: (...args) => spawnImpl(...args),
}));

vi.mock("../services/managedContainer.ts", () => ({
  resolveManagedContainer: vi.fn(async () => ({ handled: false })),
}));

let steamcmdDir;
let installDir;
vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async (key) => {
    if (key === "serverAutoUpdate") return true;
    if (key === "steamcmdPath") return steamcmdDir;
    return null;
  }),
  setSetting: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => ({
    id: "server-1",
    installPath: installDir,
  })),
}));

const { UpdateChecker } = await import("../services/updateChecker.js");

function fakeChild(code) {
  const handlers = {};
  return {
    once(event, cb) {
      handlers[event] = cb;
      return this;
    },
    _fireClose: () => handlers.close?.(code),
  };
}

function manifestPath(dir) {
  return path.join(dir, "steamapps", "appmanifest_380870.acf");
}

function writeManifest(dir, buildId) {
  fs.mkdirSync(path.join(dir, "steamapps"), { recursive: true });
  fs.writeFileSync(
    manifestPath(dir),
    `"AppState"\n{\n\t"appid"\t\t"380870"\n\t"buildid"\t\t"${buildId}"\n}\n`,
  );
}

function buildChecker() {
  const io = { emit: vi.fn() };
  const serverManager = {
    getServerProcessDetails: vi.fn(async () => ({
      running: false,
      scanFailed: false,
    })),
    startServer: vi.fn(async () => ({ success: true })),
  };
  const rconService = { connected: false };
  return {
    checker: new UpdateChecker(io, { rconService, serverManager }),
    io,
  };
}

describe("runAutoUpdate build-id verification", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-autoupdate-verify-"));
    steamcmdDir = path.join(root, "steamcmd");
    installDir = path.join(root, "install");
    fs.mkdirSync(steamcmdDir, { recursive: true });
    fs.mkdirSync(installDir, { recursive: true });
    const steamcmdExe =
      process.platform === "win32"
        ? path.join(steamcmdDir, "steamcmd.exe")
        : path.join(steamcmdDir, "steamcmd.sh");
    fs.writeFileSync(steamcmdExe, "");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports failure (not success) when SteamCMD exits 0 but the installed buildId did not change", async () => {
    writeManifest(installDir, "1000");
    spawnImpl = () => {
      const child = fakeChild(0);
      setImmediate(() => child._fireClose());
      return child;
    };

    const { checker, io } = buildChecker();
    await expect(
      checker.runAutoUpdate({
        installed: { branch: "stable", buildId: "1000" },
        latest: { buildId: "1050" },
      }),
    ).rejects.toThrow(/did not change/i);

    expect(io.emit).toHaveBeenCalledWith(
      "server:autoUpdateComplete",
      expect.objectContaining({ success: false }),
    );
    const status = await checker.getStatus();
    expect(status.lastAutoUpdateResult).toMatchObject({
      status: "failed",
      reason: "BUILD_DID_NOT_ADVANCE",
    });
  });

  it("reports success with the verified new buildId once the manifest actually advances", async () => {
    writeManifest(installDir, "1000");
    spawnImpl = () => {
      const child = fakeChild(0);
      setImmediate(() => {
        writeManifest(installDir, "1050");
        child._fireClose();
      });
      return child;
    };

    const { checker, io } = buildChecker();
    await checker.runAutoUpdate({
      installed: { branch: "stable", buildId: "1000" },
      latest: { buildId: "1050" },
    });

    expect(io.emit).toHaveBeenCalledWith(
      "server:autoUpdateComplete",
      expect.objectContaining({ success: true }),
    );
    const status = await checker.getStatus();
    expect(status.lastAutoUpdateResult).toMatchObject({
      status: "success",
      appliedVersion: "1050",
    });
  });

  it("treats an unreadable post-update manifest as a failure rather than a silent success", async () => {
    writeManifest(installDir, "1000");
    spawnImpl = () => {
      const child = fakeChild(0);
      setImmediate(() => {
        fs.rmSync(manifestPath(installDir), { force: true });
        child._fireClose();
      });
      return child;
    };

    const { checker } = buildChecker();
    await expect(
      checker.runAutoUpdate({
        installed: { branch: "stable", buildId: "1000" },
        latest: { buildId: "1050" },
      }),
    ).rejects.toThrow(/did not change/i);

    const status = await checker.getStatus();
    expect(status.lastAutoUpdateResult.reason).toBe("BUILD_DID_NOT_ADVANCE");
  });
});
