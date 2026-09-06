import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";

// 2026-09-03, Windows spawn bugs (Dwight's pz-verify repro, both real,
// neither an artifact of his setup -- reported and NOT fixed by him,
// serverManager.js is Jim's lane):
//
// (a) The default-bat path spawned `cmd.exe /c StartServer_<name>.bat` with
// a BARE filename, relying entirely on cmd.exe's own implicit
// search-cwd-for-a-bare-name behavior. NoDefaultCurrentDirectoryInExePath=1
// -- a real, non-exotic Windows hardening option -- turns that off, and
// EVERY server the panel launches on such a host fails to start with "...
// is not recognized as an internal or external command", independent of
// PanelBridge. Dwight proved it wasn't Node-specific by running the
// identical `cmd /c "StartServer_pz-verify.bat"` from the same cwd outside
// Node entirely.
//
// (b) server-launch.log (meant to capture the spawned child's stdout/
// stderr for immediate-crash reporting) stayed at 0 bytes through an
// entire successful boot, while the JVM was demonstrably printing plenty
// -- proven because PZ's own separate DebugLog was populated normally for
// that same boot. Passing a raw fd through Node's stdio array did not
// reliably carry output down through the cmd.exe -> java.exe hop under
// detached:true on Windows. Fixed by having cmd.exe do its OWN `>`/`2>&1`
// file redirection on the reconstructed command line instead.
//
// This suite intercepts child_process.spawn (never actually launches
// cmd.exe or a JVM) and asserts on the exact command/args/stdio
// serverManager.js hands it, for both the default-bat path and a custom
// .bat start command.
//
// 2026-09-04, P0 update: the argv shape these assertions check against
// changed again (see apps/panel-server/tests/serverManagerSpacedPathCmdQuoting.test.js
// for why -- the loose-argv `["/c", batPath, ">", logPath, "2>&1"]` shape
// this file originally asserted on is itself what broke every install path
// with a space in it; that is a REAL cmd.exe quoting bug this mocked suite
// is structurally unable to see, since it never invokes real cmd.exe).
// serverManager.js now builds one pre-quoted command-line string and spawns
// with windowsVerbatimArguments:true; these assertions were updated to
// match that shape. The actual real-cmd.exe space/parens regression test
// lives in serverManagerSpacedPathCmdQuoting.test.js, not here.

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

vi.mock("../utils/logger.js", () => ({
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
  // Not exercising the ETXTBSY wait loop here -- irrelevant to the two
  // fixes under test, and would otherwise poll real timers under
  // vi.useFakeTimers() below.
  manager.isJvmExecutableBusy = () => false;
  return manager;
}

async function runStart(manager) {
  const startPromise = manager.startServer({ skipRunningCheck: true });
  // _waitForImmediateCrash()'s 4s grace period.
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
        // This is the actual regression: a bare filename only resolves via
        // cmd.exe's own cwd search, which NoDefaultCurrentDirectoryInExePath
        // turns off. The absolute path is now embedded (quoted as needed)
        // inside the single pre-built command-line string, not a standalone
        // argv element.
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
        // Now a single pre-quoted command-line string (see
        // serverManagerSpacedPathCmdQuoting.test.js for why loose argv
        // tokens broke on spaced paths), not separate ">"/"2>&1" tokens.
        expect(args[1]).toMatch(/ > "?.*server-launch\.log"? 2>&1"$/);
        // No raw fd handed to spawn's stdio for the Windows branch anymore
        // -- cmd.exe does its own file open/redirect instead.
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
