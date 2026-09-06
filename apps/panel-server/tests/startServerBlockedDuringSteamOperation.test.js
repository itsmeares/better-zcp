import { describe, expect, it, afterEach } from "vitest";
import path from "path";
import { ServerManager } from "../services/serverManager.js";
import {
  getActiveSteamOperations,
  clearActiveSteamOperation,
} from "../services/activeSteamOperations.js";


const server = {
  installPath: "/opt/pz server",
};

function makeManager() {
  const manager = new ServerManager();
  Object.assign(manager, {
    configLoaded: true,
    serverName: "SteamRaceTest",
    serverPath: server.installPath,
    startCommand: null,
  });
  return manager;
}

const normalizedInstallPath = path.normalize(server.installPath).toLowerCase();

describe("startServer(): refuses to spawn the PZ JVM while SteamCMD is active for this server's install path", () => {
  afterEach(() => {
    clearActiveSteamOperation(normalizedInstallPath);
  });

  it("throws a clear, specific error instead of launching against a mid-write install directory", async () => {
    const manager = makeManager();
    getActiveSteamOperations().set(normalizedInstallPath, {
      type: "update",
      pid: process.pid,
    });

    await expect(manager.startServer({ skipRunningCheck: true })).rejects.toThrow(
      /steam install or update is currently in progress/i,
    );
  });

  it("proceeds normally once the tracked operation is cleared -- this is not a permanent lockout", async () => {
    const manager = makeManager();
    getActiveSteamOperations().set(normalizedInstallPath, {
      type: "update",
      pid: process.pid,
    });
    clearActiveSteamOperation(normalizedInstallPath);

    await expect(manager.startServer({ skipRunningCheck: true })).rejects.not.toThrow(
      /steam install or update is currently in progress/i,
    );
  });

  it("is unaffected by an operation tracked for a DIFFERENT install path", async () => {
    const manager = makeManager();
    const otherPath = path.normalize("/opt/some-other-server").toLowerCase();
    getActiveSteamOperations().set(otherPath, {
      type: "update",
      pid: process.pid,
    });

    try {
      await expect(
        manager.startServer({ skipRunningCheck: true }),
      ).rejects.not.toThrow(/steam install or update is currently in progress/i);
    } finally {
      clearActiveSteamOperation(otherPath);
    }
  });
});
