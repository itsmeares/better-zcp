import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { getDataPaths } from "../utils/paths.ts";
import { acquireLock, releaseLock } from "../utils/pidLock.ts";
import { isPidAlive } from "../utils/pidLiveness.ts";
import { acknowledgeUpdateBundle, applyUpdateBundle, readUpdateBundleJournalIfPresent, recoverInterruptedUpdateBundle, validateBuildCompatibility, type BuildMetadata } from "./updateBundle.ts";

import { PANEL_SUPERVISOR_VERSION } from "./runtimeInfo.ts";
export const PANEL_RESTART_EXIT = 75;

function readRestartRequest(installDir: string): { port: number; update: boolean } {
  const request = JSON.parse(fs.readFileSync(path.join(installDir, ".panel-restart.json"), "utf8"));
  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535 || typeof request.update !== "boolean") throw new Error("Invalid panel restart request.");
  return request;
}

export function writePanelRestartRequest(installDir: string, port: number, update: boolean): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Panel listening port is unavailable.");
  const file = path.join(installDir, ".panel-restart.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ port, update }), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

async function waitForHealth(child: ChildProcess, port: number, metadata: BuildMetadata, instanceId: string, timeout: number) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("New panel exited before becoming healthy.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
      if (response.ok) {
        const health = await response.json() as Record<string, unknown>;
        if (health.status === "ok" && health.instanceId === instanceId && validateBuildCompatibility(metadata, health).compatible) return health;
      }
    } catch { /* It may still be starting. Each request has a bounded timeout. */ }
    await delay(250);
  }
  throw new Error("New panel did not pass the HTTP health check.");
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise(resolve => child.once("close", code => resolve(code)));
}

async function stopPanel(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.connected) child.send({ type: "panel:shutdown" });
  else child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout>;
  await Promise.race([exited(child), new Promise<void>(resolve => { timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 120000); })]);
  clearTimeout(timer!);
  // Windows must release the executable handle before rollback renames it.
  await exited(child);
}

/** One owner for Linux and Windows updates. Never signals a process group or a game process. */
export async function runPanelSupervisor(options: { binary: string; args?: string[]; dataDirectory: string; healthTimeout?: number }): Promise<number> {
  const install = path.dirname(options.binary);
  const journalFile = path.join(install, "update-bundle.json");
  const requestFile = path.join(install, ".panel-restart.json");
  const resultFile = path.join(install, "panel-update-result.json");
  const lock = acquireLock(install, ".panel-supervisor.lock");
  if (!lock.acquired) throw new Error(lock.reason);
  // A Windows executable cannot unlink itself. Remove stopped runners on the next startup.
  for (const name of fs.readdirSync(install)) {
    if (!/^\.panel-runner-(?:[0-9a-f-]{36}|\d+|\d+-\d+)(?:\.exe)?$/.test(name)) continue;
    const file = path.join(install, name);
    if (file === process.execPath) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || Date.now() - stat.mtimeMs < 60000) continue;
    try { fs.rmSync(file); } catch { /* An active Windows runner stays locked. */ }
  }
  let child: ChildProcess | null = null;
  let stopping = false;
  const stop = () => { stopping = true; if (child) void stopPanel(child); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const launch = () => {
    const instanceId = crypto.randomUUID();
    child = spawn(options.binary, [...options.args ?? [], "--panel-child"], {
      cwd: install, stdio: ["inherit", "inherit", "inherit", "ipc"], windowsHide: true,
      env: { ...process.env, PANEL_SUPERVISOR_V: PANEL_SUPERVISOR_VERSION, PANEL_PRESERVE_GAME_SERVERS: "1", PANEL_INSTANCE_ID: instanceId },
    });
    // A spawn failure has no exit event. Convert it into a settled exit for the loop.
    child.on("error", err => { console.error(`Panel launch failed: ${err.message}`); });
    return { child, instanceId };
  };
  const record = (status: "success" | "failed", version: string, message?: string) => {
    try {
      fs.writeFileSync(`${resultFile}.tmp`, JSON.stringify({ status, at: new Date().toISOString(), ...(status === "success" ? { appliedVersion: version } : { pendingVersion: version }), message }), { mode: 0o600 });
      fs.renameSync(`${resultFile}.tmp`, resultFile);
    } catch (e) { console.error(`Could not record panel update ${status}: ${(e as Error).message}`); }
  };
  try {
    // Do not recover files while an independently started panel still owns them.
    const panelLock = path.join(options.dataDirectory, "panel.lock");
    if (fs.existsSync(panelLock) && isPidAlive(Number(fs.readFileSync(panelLock, "utf8")))) throw new Error("Another panel process is running. Update recovery refused.");
    const interrupted = readUpdateBundleJournalIfPresent(journalFile);
    if (interrupted && interrupted.phase !== "staged") {
      recoverInterruptedUpdateBundle(journalFile, options.dataDirectory);
      record("failed", interrupted.version, "Interrupted update restored before startup.");
    }
    fs.rmSync(requestFile, { force: true });
    let crashes = 0;
    launch();
    while (true) {
      const startedAt = Date.now();
      const code = await exited(child!);
      if (stopping || code === 0 || code === 78) return code === 78 ? 78 : 0;
      if (code === PANEL_RESTART_EXIT) {
        const request = readRestartRequest(install);
        fs.rmSync(requestFile);
        if (request.update) {
          const staged = readUpdateBundleJournalIfPresent(journalFile);
          if (!staged || staged.phase !== "staged") throw new Error("Panel requested an update without a staged bundle.");
          try {
            const applied = applyUpdateBundle(journalFile, options.dataDirectory);
            const next = launch();
            const health = await waitForHealth(next.child, request.port, applied.metadata, next.instanceId, options.healthTimeout ?? 60000);
            acknowledgeUpdateBundle(journalFile, health);
            record("success", staged.version);
          } catch (e) {
            if (child) await stopPanel(child);
            recoverInterruptedUpdateBundle(journalFile, options.dataDirectory);
            record("failed", staged.version, (e as Error).message);
            console.error(`Panel update failed; previous panel restored: ${(e as Error).message}`);
            if (!stopping) launch();
          }
        } else if (!stopping) launch();
        crashes = 0;
        continue;
      }
      if (Date.now() - startedAt >= 60000) crashes = 0;
      crashes += 1;
      if (crashes > 5) return code || 1;
      await delay(Math.min(crashes * 2000, 30000));
      if (stopping) return 0;
      launch();
    }
  } finally {
    if (child && stopping) await stopPanel(child);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    releaseLock();
  }
}

export async function bootNativePanel(): Promise<void> {
  const install = path.dirname(process.execPath);
  if (!process.argv.includes("--panel-supervisor")) {
    // The runner is a separate executable: Windows can replace the panel binary after its child exits.
    const runner = path.join(install, `.panel-runner-${crypto.randomUUID()}${process.platform === "win32" ? ".exe" : ""}`);
    fs.copyFileSync(process.execPath, runner, fs.constants.COPYFILE_EXCL);
    if (process.platform !== "win32") fs.chmodSync(runner, 0o755);
    const args = ["--panel-supervisor"];
    if (process.platform === "win32") {
      const logs = path.join(install, "logs"); fs.mkdirSync(logs, { recursive: true });
      const output = fs.openSync(path.join(logs, "panel-supervisor.log"), "a", 0o600);
      let child: ChildProcess;
      try { child = spawn(runner, args, { cwd: install, stdio: ["ignore", output, output], detached: true, windowsHide: false }); }
      finally { fs.closeSync(output); }
      child.on("error", err => { console.error(err.message); process.exitCode = 1; });
      child.once("spawn", () => { child.unref(); process.exit(0); });
    } else {
      const child = spawn(runner, args, { cwd: install, stdio: "inherit" });
      const stop = () => child.kill("SIGTERM");
      process.on("SIGTERM", stop); process.on("SIGINT", stop);
      try { process.exitCode = await exited(child) ?? 1; }
      finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
    }
    return;
  }
  const binary = path.join(install, process.platform === "win32" ? "ZomboidControlPanel.exe" : "ZomboidControlPanel");
  try { process.exitCode = await runPanelSupervisor({ binary, dataDirectory: getDataPaths().dataDir }); }
  finally {
    if (process.platform !== "win32") fs.rmSync(process.execPath, { force: true });
  }
}
