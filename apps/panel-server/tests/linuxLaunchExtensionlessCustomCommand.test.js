import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


const isLinux = process.platform !== "win32";

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
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

(isLinux ? describe : describe.skip)(
  "startServer() with a no-extension custom command on Linux",
  () => {
    let tmpDir;
    let scriptPath;
    let spawnedPid;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "pz-linux-launch-noext-"),
      );
      scriptPath = path.join(tmpDir, "launcher");
      fs.writeFileSync(scriptPath, "#!/bin/sh\nsleep 30\n", "utf8");
      fs.chmodSync(scriptPath, 0o644);

      getActiveServer.mockResolvedValue({
        serverName: "LinuxNoExtLauncher",
        serverPath: tmpDir,
        startCommand: scriptPath,
      });
    });

    afterEach(() => {
      if (spawnedPid) {
        try {
          process.kill(spawnedPid, "SIGKILL");
        } catch {
          /* already gone */
        }
        spawnedPid = undefined;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("chmods the extensionless command before spawning it, so a non-executable file still starts", async () => {
      expect(fs.statSync(scriptPath).mode & 0o111).toBe(0);

      const manager = new ServerManager();
      const result = await manager.startServer({ skipRunningCheck: true });
      spawnedPid = manager.serverProcess?.pid;

      expect(result.success).toBe(true);
      expect(fs.statSync(scriptPath).mode & 0o100).not.toBe(0);
    });

    it("fails with a permission error if the exec bit is never set (proves the test can detect the bug)", async () => {
      const { spawn } = await import("child_process");
      await new Promise((resolve) => {
        const proc = spawn(scriptPath, [], { stdio: "ignore" });
        proc.once("error", (err) => {
          expect(err.code).toBe("EACCES");
          resolve();
        });
        proc.once("exit", () => {
          throw new Error(
            "expected EACCES on a non-executable file, but spawn succeeded -- positive control is broken",
          );
        });
      });
    });
  },
);
