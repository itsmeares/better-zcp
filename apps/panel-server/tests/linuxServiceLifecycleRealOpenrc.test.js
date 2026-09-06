import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildLifecycleTemplate, getLifecycleServiceName } from "../services/linuxServiceLifecycle.ts";

const INIT_D = "/etc/init.d";
const EXEC_TIMEOUT_MS = 15_000;

function hasRealOpenrc() {
  try {
    execFileSync("rc-service", ["--version"], { stdio: "ignore" });
    execFileSync("openrc-run", ["--version"], { stdio: "ignore" });
    execFileSync("supervise-daemon", [], {
      stdio: "ignore",
      env: { ...process.env, RC_SVCNAME: "probe" },
    });
    return true;
  } catch (error) {
    return error.code !== "ENOENT";
  }
}

const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const HAS_OPENRC = hasRealOpenrc();
const CAN_RUN = HAS_OPENRC && IS_ROOT;

if (!CAN_RUN) {
  console.warn(
    "\n" +
      "!".repeat(78) +
      "\nSKIPPING linuxServiceLifecycleRealOpenrc.test.js: " +
      (!HAS_OPENRC
        ? "real OpenRC tooling (rc-service/openrc-run/supervise-daemon) is not on this host."
        : "not running as root -- installing into /etc/init.d/ and driving rc-service requires it.") +
      "\nThe generated OpenRC script was NEVER started under a real init system on this run.\n" +
      "This is a degraded run, not a clean pass -- do not treat a green suite here as proof\n" +
      "the service actually starts, respawns, or stops. This test is invasive by design (no\n" +
      "OpenRC equivalent of `systemd-analyze verify` exists) -- run it only inside a disposable\n" +
      "container such as `alpine:latest` + `apk add openrc bash coreutils`.\n" +
      "!".repeat(78) +
      "\n",
  );
}

function writeFakeLauncher(dir) {
  const launcherPath = path.join(dir, "start-server.sh");
  fs.writeFileSync(
    launcherPath,
    "#!/bin/bash\n" +
      'echo "started cwd=$(pwd) marker_env=$ZOMBOID_PANEL_SERVER_ID" >> "$(dirname "$0")/marker.log"\n' +
      "trap 'exit 0' TERM\n" +
      "while true; do sleep 1; done\n",
    { mode: 0o755 },
  );
  return launcherPath;
}

let caseCounter = 0;
function makeServer(overrides = {}) {
  caseCounter += 1;
  return { id: `openrctest${caseCounter}`, serverName: "servertest", ...overrides };
}

function install(serviceName, content) {
  const target = path.join(INIT_D, serviceName);
  fs.writeFileSync(target, content, { mode: 0o755 });
  return target;
}

function pidsWithCmdlineContaining(substring) {
  const matches = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ");
      if (cmdline.includes(substring)) matches.push(entry);
    } catch {
      // process exited between readdir and read -- ignore
    }
  }
  return matches;
}

function rcService(serviceName, action) {
  try {
    return {
      code: 0,
      timedOut: false,
      output: execFileSync("rc-service", [serviceName, action], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: EXEC_TIMEOUT_MS,
      }),
    };
  } catch (error) {
    return {
      code: error.status ?? 1,
      output: `${error.stdout || ""}${error.stderr || ""}`,
      timedOut: Boolean(error.signal),
    };
  }
}

const installedServiceNames = new Set();

function cleanupAll() {
  for (const serviceName of installedServiceNames) {
    try {
      execFileSync("rc-service", [serviceName, "stop"], {
        stdio: "ignore",
        timeout: EXEC_TIMEOUT_MS,
      });
    } catch {
      // best-effort -- the service may already be stopped or never started
    }
    fs.rmSync(path.join(INIT_D, serviceName), { force: true });
  }
  installedServiceNames.clear();
}

const describeRealOpenrc = CAN_RUN ? describe : describe.skip;

describeRealOpenrc(
  "linuxServiceLifecycle OpenRC provider -- verified against REAL rc-service/supervise-daemon (SKIPPED: see banner above if this line is not running)",
  () => {
    let tmpDir;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-openrc-verify-"));
    });

    afterEach(() => {
      cleanupAll();
    });

    const CASES = [
      { label: "plain path, no special characters", dirName: "plain", pwnedMarker: null },
      { label: "path containing a space", dirName: "pz server", pwnedMarker: null },
      {
        label: "path containing a $(...) injection payload",
        dirName: "pz$(touch /tmp/openrc-pwned-case3)server",
        pwnedMarker: "/tmp/openrc-pwned-case3",
      },
    ];

    for (const { label, dirName, pwnedMarker } of CASES) {
      it(`starts, is supervised, and stops cleanly through real rc-service -- ${label}`, () => {
        if (pwnedMarker) fs.rmSync(pwnedMarker, { force: true });
        const workDir = path.join("/tmp", dirName);
        fs.mkdirSync(workDir, { recursive: true });
        const launcherPath = writeFakeLauncher(workDir);

        const server = makeServer({ installPath: workDir });
        const serviceName = getLifecycleServiceName(server);
        const template = buildLifecycleTemplate(
          server,
          "openrc",
          { fileExists: (candidate) => candidate === path.join(workDir, "start-server.sh") },
        );
        expect(template.filename).toBe(serviceName);
        installedServiceNames.add(serviceName);
        install(serviceName, template.content);

        const start = rcService(serviceName, "start");
        expect(start.timedOut, `rc-service start hung: ${start.output}`).toBe(false);
        expect(start.code, `rc-service start failed: ${start.output}`).toBe(0);

        if (pwnedMarker) expect(fs.existsSync(pwnedMarker)).toBe(false);

        const markerLog = path.join(workDir, "marker.log");
        expect(fs.existsSync(markerLog)).toBe(true);
        const marker = fs.readFileSync(markerLog, "utf8");
        expect(marker).toContain(`cwd=${workDir}`);
        expect(marker).toContain(`marker_env=${server.id}`);

        const stop = rcService(serviceName, "stop");
        expect(stop.timedOut, `rc-service stop hung: ${stop.output}`).toBe(false);
        expect(stop.code, `rc-service stop failed: ${stop.output}`).toBe(0);

        expect(pidsWithCmdlineContaining(launcherPath)).toEqual([]);
      });
    }

    it("respawns the supervised process after it is killed (respawn_delay=5, respawn_max=0)", () => {
      const workDir = path.join(tmpDir, "respawn");
      fs.mkdirSync(workDir, { recursive: true });
      const launcherPath = writeFakeLauncher(workDir);

      const server = makeServer({ installPath: workDir });
      const serviceName = getLifecycleServiceName(server);
      const template = buildLifecycleTemplate(
        server,
        "openrc",
        { fileExists: (candidate) => candidate === path.join(workDir, "start-server.sh") },
      );
      installedServiceNames.add(serviceName);
      install(serviceName, template.content);

      const start = rcService(serviceName, "start");
      expect(start.code, `rc-service start failed: ${start.output}`).toBe(0);

      const [firstPid] = pidsWithCmdlineContaining(launcherPath);
      expect(firstPid).toMatch(/^\d+$/);

      execFileSync("kill", ["-9", firstPid], { timeout: EXEC_TIMEOUT_MS });

      let secondPid;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const [candidate] = pidsWithCmdlineContaining(launcherPath);
        if (candidate && candidate !== firstPid) {
          secondPid = candidate;
          break;
        }
        execFileSync("sleep", ["0.2"], { timeout: EXEC_TIMEOUT_MS });
      }

      expect(secondPid, "supervise-daemon never respawned the killed process").toMatch(/^\d+$/);
      expect(secondPid).not.toBe(firstPid);

      const stop = rcService(serviceName, "stop");
      expect(stop.code, `rc-service stop failed: ${stop.output}`).toBe(0);
    }, 20_000);

    it("does not corrupt a description containing a literal $ with a spurious backslash", () => {
      const workDir = path.join(tmpDir, "dollar-name");
      fs.mkdirSync(workDir, { recursive: true });
      writeFakeLauncher(workDir);

      const server = makeServer({ name: "Alpha $CoolServer", installPath: workDir });
      const serviceName = getLifecycleServiceName(server);
      const template = buildLifecycleTemplate(
        server,
        "openrc",
        { fileExists: (candidate) => candidate === path.join(workDir, "start-server.sh") },
      );
      installedServiceNames.add(serviceName);
      install(serviceName, template.content);

      const start = rcService(serviceName, "start");
      expect(start.code, `rc-service start failed: ${start.output}`).toBe(0);
      expect(start.output).toContain("$CoolServer");
      expect(start.output).not.toContain("\\$CoolServer");

      const stop = rcService(serviceName, "stop");
      expect(stop.code, `rc-service stop failed: ${stop.output}`).toBe(0);
    });
  },
);
