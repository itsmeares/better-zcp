import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";


const spawnCalls = [];
const spawnMock = vi.fn(() => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.unref = vi.fn();
  child.kill = vi.fn();
  return child;
});

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return spawnMock(command, args, options);
    },
  };
});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
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

const isWindowsHost = process.platform === "win32";

function makeManager(tmpRoot, serverBat) {
  const manager = new ServerManager();
  Object.assign(manager, {
    configLoaded: true,
    serverName: "SpawnFixTest",
    serverPath: tmpRoot,
    serverBat,
    startCommand: "",
    lifecycleProvider: "direct",
  });
  manager.isJvmExecutableBusy = () => false;
  return manager;
}

async function runStart(manager) {
  const startPromise = manager.startServer({ skipRunningCheck: true });
  await vi.advanceTimersByTimeAsync(4000);
  return startPromise;
}

(isWindowsHost ? describe : describe.skip)(
  "ServerManager.startServer() Windows spawn fixes",
  () => {
    let tmpRoot;

    beforeEach(() => {
      vi.useFakeTimers();
      spawnCalls.length = 0;
      spawnMock.mockClear();
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-winspawn-"));
    });

    afterEach(() => {
      vi.useRealTimers();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    describe("default-bat path", () => {
      it("spawns the resolved absolute batch path, not the bare filename", async () => {
        const serverBat = "StartServer_pz-verify.bat";
        fs.writeFileSync(path.join(tmpRoot, serverBat), "@echo off\r\n");
        const manager = makeManager(tmpRoot, serverBat);

        const result = await runStart(manager);

        expect(result.success).toBe(true);
        expect(spawnCalls).toHaveLength(1);
        const { command, args, options } = spawnCalls[0];
        expect(command).toBe("cmd.exe");
        expect(args[0]).toBe("/c");
        const absoluteBatPath = path.join(tmpRoot, serverBat);
        expect(args[1]).toContain(absoluteBatPath);
        expect(args[1]).not.toBe(serverBat);
        expect(options.windowsVerbatimArguments).toBe(true);
      });

      it("has cmd.exe redirect stdout/stderr to server-launch.log itself, not a raw fd through Node's stdio", async () => {
        const serverBat = "StartServer_pz-verify.bat";
        fs.writeFileSync(path.join(tmpRoot, serverBat), "@echo off\r\n");
        const manager = makeManager(tmpRoot, serverBat);

        await runStart(manager);

        const { args, options } = spawnCalls[0];
        expect(args[1]).toMatch(/ > "?.*server-launch\.log"? 2>&1"$/);
        expect(options.stdio).toBe("ignore");
      });
    });

    describe("custom .bat start command path", () => {
      it("spawns the custom command's absolute path with the same redirection fix", async () => {
        const customBat = "MyLauncher.bat";
        const customPath = path.join(tmpRoot, customBat);
        fs.writeFileSync(customPath, "@echo off\r\n");
        const manager = makeManager(tmpRoot, "unused.bat");
        manager.startCommand = customPath;

        const result = await runStart(manager);

        expect(result.success).toBe(true);
        expect(spawnCalls).toHaveLength(1);
        const { command, args, options } = spawnCalls[0];
        expect(command).toBe("cmd.exe");
        expect(args[0]).toBe("/c");
        expect(args[1]).toContain(customPath);
        expect(args[1]).toMatch(/ > "?.*server-launch\.log"? 2>&1"$/);
        expect(options.stdio).toBe("ignore");
        expect(options.windowsVerbatimArguments).toBe(true);
      });
    });
  },
);
