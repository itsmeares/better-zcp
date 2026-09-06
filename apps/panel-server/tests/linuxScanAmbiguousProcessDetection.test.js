import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";


const isLinux = process.platform !== "win32";

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

function makeManager(overrides) {
  const manager = new ServerManager();
  Object.assign(manager, { configLoaded: true, ...overrides });
  return manager;
}

(isLinux ? describe : describe.skip)(
  "getServerProcessDetails(): honest about scan uncertainty on Linux, without over-broadening",
  () => {
    let tmpDir;
    let fakeJava;
    let fakeNonJava;
    const spawnedPids = [];

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-scan-ambiguous-"));
      fakeJava = path.join(tmpDir, "java");
      fs.writeFileSync(fakeJava, "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
      fakeNonJava = path.join(tmpDir, "zomboid-control-panel-worker");
      fs.writeFileSync(fakeNonJava, "#!/bin/bash\nsleep 30\n", {
        mode: 0o755,
      });
    });

    afterEach(async () => {
      while (spawnedPids.length) {
        const pid = spawnedPids.pop();
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          continue;
        }
        const deadline = Date.now() + 5000;
        while (fs.existsSync(`/proc/${pid}`) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function spawnBg(execPath, args) {
      const proc = spawn(execPath, args, { detached: true, stdio: "ignore" });
      proc.unref();
      spawnedPids.push(proc.pid);
      return proc.pid;
    }

    async function waitUntilVisibleInProcTable(pid, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          if (fs.readFileSync(`/proc/${pid}/cmdline`).length > 0) return;
        } catch {
          /* not there yet, or already gone -- keep polling until the deadline */
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`Timed out waiting for pid ${pid} to appear in /proc`);
    }

    it("THE LIVE BUG: a -jar-style launch (a real, running PZ server the narrow matcher doesn't recognize) reports scanFailed:true, not a confident running:false", async () => {
      await waitUntilVisibleInProcTable(spawnBg(fakeJava, ["-jar", "projectzomboid.jar"]));

      const manager = makeManager({
        serverName: "NewServer",
        savePath: "/tmp/NewServerZomboid",
        serverPath: "/opt/NewServer",
      });
      const details = await manager.getServerProcessDetails();

      expect(details.running).toBe(false);
      expect(details.scanFailed).toBe(true);
    });

    it("THE CI REGRESSION: a non-java process whose own path/name merely mentions zomboid (a sibling test worker, a shell in a zomboid-named checkout) is discarded as noise, NOT treated as ambiguous evidence", async () => {
      await waitUntilVisibleInProcTable(spawnBg(fakeNonJava, []));

      const manager = makeManager({
        serverName: "IdleServer",
        savePath: "/tmp/IdleServerZomboid",
        serverPath: "/opt/IdleServer",
      });
      const details = await manager.getServerProcessDetails();

      expect(details.running).toBe(false);
      expect(details.scanFailed).toBe(false);
    });

    it("positive control: the panel's own generated-script shape is still confirmed normally (proves the fix didn't weaken real detection)", async () => {
      await waitUntilVisibleInProcTable(
        spawnBg(fakeJava, [
          "-Djava.library.path=natives/",
          "-cp",
          "java/.",
          "zombie.network.GameServer",
          "-servername",
          "GoodServer",
          "-cachedir=/tmp/GoodServerZomboid",
        ]),
      );

      const manager = makeManager({
        serverName: "GoodServer",
        savePath: "/tmp/GoodServerZomboid",
        serverPath: "/opt/GoodServer",
      });
      const details = await manager.getServerProcessDetails();

      expect(details.running).toBe(true);
      expect(details.scanFailed).toBe(false);
      expect(details.owned).toHaveLength(1);
    });

    it("a genuinely idle host (nothing spawned at all) still reports confidently stopped -- the fix must not make every check say unknown", async () => {
      const manager = makeManager({
        serverName: "IdleServer2",
        savePath: "/tmp/IdleServer2Zomboid",
        serverPath: "/opt/IdleServer2",
      });
      const details = await manager.getServerProcessDetails();

      expect(details.running).toBe(false);
      expect(details.scanFailed).toBe(false);
    });
  },
);
