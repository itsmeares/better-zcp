import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


const isLinux = process.platform !== "win32";

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
  getServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

vi.mock("../utils/logger.ts", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { ServerManager } = await import("../services/serverManager.js");

async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

(isLinux ? describe : describe.skip)(
  "ServerManager.isJvmExecutableBusy -- kernel-level ETXTBSY check",
  () => {
    let tmpDir;
    let javaPath;
    let child;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-jvm-busy-"));
      fs.mkdirSync(path.join(tmpDir, "jre64", "bin"), { recursive: true });
      javaPath = path.join(tmpDir, "jre64", "bin", "java");
      fs.copyFileSync("/bin/sleep", javaPath);
      fs.chmodSync(javaPath, 0o755);
    });

    afterEach(async () => {
      if (child && child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      child = undefined;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("reports busy while the binary is genuinely being executed", async () => {
      const { spawn } = await import("child_process");
      child = spawn(javaPath, ["30"], {
        argv0: "sleep",
        stdio: "ignore",
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      const manager = new ServerManager();
      manager.serverPath = tmpDir;

      expect(manager.isJvmExecutableBusy()).toBe(true);
    });

    it("clears once the process actually exits", async () => {
      const { spawn } = await import("child_process");
      child = spawn(javaPath, ["30"], {
        argv0: "sleep",
        stdio: "ignore",
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      const manager = new ServerManager();
      manager.serverPath = tmpDir;
      expect(manager.isJvmExecutableBusy()).toBe(true);

      child.kill("SIGKILL");
      const cleared = await waitUntil(() => !manager.isJvmExecutableBusy());
      expect(cleared).toBe(true);
    });

    it("is not busy when the file exists but nothing is executing it", () => {
      const manager = new ServerManager();
      manager.serverPath = tmpDir;

      expect(manager.isJvmExecutableBusy()).toBe(false);
    });

    it("is not busy (best-effort false, not an error) when no jre64/jre directory exists at all", () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-jvm-busy-empty-"));
      try {
        const manager = new ServerManager();
        manager.serverPath = emptyDir;

        expect(manager.isJvmExecutableBusy()).toBe(false);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it("startServer() proceeds (never throws the busy error) if the shared install's JVM binary stays busy the whole bounded wait -- that busy-ness may belong to an unrelated sibling server", async () => {
      const { spawn } = await import("child_process");
      child = spawn(javaPath, ["30"], {
        argv0: "sleep",
        stdio: "ignore",
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      getActiveServer.mockResolvedValue({
        serverName: "JvmBusyTest",
        serverPath: tmpDir,
        serverBat: "start-server.sh",
        rconPort: 1,
      });

      const manager = new ServerManager();
      await expect(
        manager.startServer({ skipRunningCheck: false }),
      ).rejects.not.toThrow(/Text file busy/);
    }, 10000);

    it("startServer({skipRunningCheck: true}) ALSO waits for the busy binary to clear -- this is the flag scheduler.js's performRestart() actually uses", async () => {
      const { spawn } = await import("child_process");
      child = spawn(javaPath, ["30"], {
        argv0: "sleep",
        stdio: "ignore",
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      getActiveServer.mockResolvedValue({
        serverName: "JvmBusyTest",
        serverPath: tmpDir,
        serverBat: "start-server.sh",
        rconPort: 1,
      });

      const manager = new ServerManager();
      vi.spyOn(manager, "isJvmExecutableBusy").mockReturnValue(true);
      const sleepSpy = vi
        .spyOn(manager, "sleep")
        .mockResolvedValue(undefined);
      await expect(
        manager.startServer({ skipRunningCheck: true }),
      ).rejects.not.toThrow(/Text file busy/);

      expect(sleepSpy).toHaveBeenCalledTimes(10);
      expect(sleepSpy).toHaveBeenCalledWith(300);
    }, 10000);

    it("startServer() stops waiting as soon as the binary frees, rather than always sleeping the full bound", async () => {
      getActiveServer.mockResolvedValue({
        serverName: "JvmBusyTest",
        serverPath: tmpDir,
        serverBat: "start-server.sh",
        rconPort: 1,
      });

      const manager = new ServerManager();
      vi.spyOn(manager, "getServerProcessDetails").mockResolvedValue({
        running: false,
        scanFailed: false,
      });
      vi.spyOn(manager, "isJvmExecutableBusy")
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValue(false);
      const sleepSpy = vi
        .spyOn(manager, "sleep")
        .mockResolvedValue(undefined);
      await expect(
        manager.startServer({ skipRunningCheck: false }),
      ).rejects.not.toThrow(/Text file busy/);

      const sleepCalls = sleepSpy.mock.calls;
      expect(sleepCalls.length).toBeGreaterThan(1);
      expect(sleepCalls.length).toBeLessThan(10);
      for (const call of sleepCalls) {
        expect(call[0]).toBe(300);
      }
    }, 10000);
  },
);

describe("ServerManager.isJvmExecutableBusy -- non-Linux / no-binary fallthrough", () => {
  it("is not busy when serverPath is empty (nothing configured yet)", () => {
    const manager = new ServerManager();
    manager.serverPath = "";

    expect(manager.isJvmExecutableBusy()).toBe(false);
  });
});
