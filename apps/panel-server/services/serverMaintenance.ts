import fs from "node:fs";
import { hasActiveSteamOperation, steamInstallKey } from "./activeSteamOperations.ts";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getServer, type ServerRecord } from "../database/init.ts";
import { runForServer } from "../utils/serverScope.ts";
import { createLogger } from "../utils/logger.ts";
import { createBackupIfChanged } from "../utils/configBackup.ts";
import { acquireLifecycleLock, type LifecycleLock } from "./lifecycleCoordinator.ts";
import { resolveProvider } from "../utils/serverStatusModel.ts";
import { ensureBundledGameContainer, isBundledGameProfile, resolveDockerHostSignal, runManagedLifecycle } from "./managedContainer.ts";
import { candidateIniPaths, isFirstBootMissingAdminPassword, refreshLaunchTargetBeforeStart } from "./serverLaunch.ts";
import { ensureGameIntegrationInstalled } from "./gameIntegrationInstaller.ts";

const log = createLogger("Maintenance");
export type MaintenancePolicy = { waitMinutes: number; forceAfterDeadline: boolean; warningMinutes: number };
export const defaultMaintenancePolicy: MaintenancePolicy = { waitMinutes: 60, forceAfterDeadline: false, warningMinutes: 15 };
export type MaintenanceResult = { success: boolean; deferred?: boolean; cancelled?: boolean; skipped?: boolean; message?: string; [key: string]: any };
type Kind = "restart" | "workshop" | "backup" | "pz-update";
type Phase = "waiting" | "countdown" | "saving" | "stopping" | "working" | "starting";
type Options = {
  kind: Kind; label: string; automatic?: boolean; policy?: MaintenancePolicy; warningMinutes?: number;
  lifecycleLock?: LifecycleLock | null; work?: (signal: AbortSignal) => Promise<MaintenanceResult>;
  notice?: (count: number, unit: "minutes" | "seconds") => string;
};

export class ServerMaintenance {
  active: { kind: Kind; label: string; phase: Phase; startedAt: string } | null = null;
  private controller: AbortController | null = null;
  private currentRun: Promise<MaintenanceResult> | null = null;
  readonly serverId: string;
  readonly rcon: any;
  readonly manager: any;
  readonly io: any;
  constructor(serverId: string, rcon: any, manager: any, io: any) {
    this.serverId = serverId; this.rcon = rcon; this.manager = manager; this.io = io;
  }

  cancel(kind?: Kind): boolean {
    if (!this.active || kind && this.active.kind !== kind || !["waiting", "countdown"].includes(this.active.phase)) return false;
    this.controller?.abort(new Error("Maintenance cancelled before stopping the server."));
    return true;
  }
  async shutdown(): Promise<void> {
    this.controller?.abort(new Error("Panel is shutting down."));
    await this.currentRun;
  }
  private phase(phase: Phase) {
    if (this.active) this.active.phase = phase;
    this.io?.emit("maintenance:status", this.active);
  }
  private async profile(): Promise<ServerRecord> {
    const server = await getServer(this.serverId);
    if (!server) throw new Error("The server profile no longer exists.");
    return server;
  }
  async state(): Promise<{ running: boolean }> {
    const server = await this.profile();
    const provider = resolveProvider(server);
    const details = provider === "docker-local" || provider === "docker-managed"
      ? await resolveDockerHostSignal(server)
      : await this.manager.getServerProcessDetails();
    if (!details || details.scanFailed || typeof details.running !== "boolean") throw new Error("Server state could not be verified. Maintenance was deferred.");
    if (provider === "native" && !details.running && this.rcon.connected) {
      const players = await this.rcon.getPlayers().catch(() => null);
      if (players?.success) throw new Error("Process and RCON state disagree. Maintenance was deferred.");
    }
    return { running: details.running };
  }
  private async players(): Promise<number> {
    if (!this.rcon.connected) throw new Error("RCON is not connected. Maintenance was deferred.");
    const result = await this.rcon.getPlayers();
    if (!result?.success || !Array.isArray(result.players)) throw new Error("Player count could not be verified. Maintenance was deferred.");
    return result.players.length;
  }
  private async announce(text: string): Promise<void> {
    const result = await this.rcon.serverMessage(text, { skipLog: true });
    if (result?.success !== true || result.rejected) {
      throw new Error("Players could not be warned. The server was left running.");
    }
  }
  private async countdown(options: Options, minutes: number, signal: AbortSignal): Promise<void> {
    this.phase("countdown");
    const ticks = [minutes * 60, ...[10, 5, 3, 2, 1].filter(value => value < minutes).map(value => value * 60), 30, 10, 5, 4, 3, 2, 1].filter((value, index, all) => value > 0 && all.indexOf(value) === index).sort((a, b) => b - a);
    let previous = minutes * 60;
    for (const seconds of ticks) {
      await delay((previous - seconds) * 1000, undefined, { signal });
      await this.state(); await this.players(); signal.throwIfAborted();
      const count = seconds >= 60 ? seconds / 60 : seconds, unit = seconds >= 60 ? "minutes" : "seconds";
      await this.announce(options.notice?.(count, unit) || `${options.label} in ${count} ${unit}. The server will save and restart.`);
      previous = seconds;
    }
    await delay(previous * 1000, undefined, { signal });
  }
  private async preparePlayers(options: Options, signal: AbortSignal): Promise<{ force: boolean }> {
    if (!options.automatic) {
      const count = await this.players();
      if ((options.warningMinutes || 0) > 0 && count > 0) await this.countdown(options, options.warningMinutes!, signal);
      return { force: true };
    }
    const policy = options.policy || defaultMaintenancePolicy;
    if (!Number.isInteger(policy.waitMinutes) || policy.waitMinutes < 1 || policy.waitMinutes > 1440 || !Number.isInteger(policy.warningMinutes) || policy.warningMinutes < 1 || policy.warningMinutes > policy.waitMinutes || typeof policy.forceAfterDeadline !== "boolean") throw new Error("Invalid maintenance player policy.");
    const deadline = Date.now() + policy.waitMinutes * 60000;
    while (true) {
      signal.throwIfAborted();
      if (!(await this.state()).running) return { force: false };
      const count = await this.players();
      if (!policy.forceAfterDeadline && Date.now() >= deadline) throw new Error("Player waiting window expired. Maintenance was deferred.");
      if (count === 0) return { force: false };
      this.phase("waiting");
      if (policy.forceAfterDeadline && Date.now() >= deadline - policy.warningMinutes * 60000) {
        await this.countdown(options, policy.warningMinutes, signal);
        return { force: true };
      }
      if (Date.now() >= deadline) throw new Error("Player waiting window expired. Maintenance was deferred.");
      await delay(Math.min(5000, deadline - Date.now()), undefined, { signal });
    }
  }
  private async waitForState(running: boolean, timeout: number, signal?: AbortSignal) {
    const deadline = Date.now() + timeout;
    while (true) {
      signal?.throwIfAborted();
      if ((await this.state()).running === running) return;
      if (Date.now() >= deadline) throw new Error(running ? "Server did not start within 60 seconds." : "Server did not stop within 60 seconds. No maintenance work was performed.");
      await delay(1000, undefined, signal ? { signal } : undefined);
    }
  }
  private async resumeServer(): Promise<void> {
    const server = await this.profile();
    if (isFirstBootMissingAdminPassword(server)) throw new Error("This server needs an admin password before its first start.");
    if (server.installPath && hasActiveSteamOperation(steamInstallKey(server.installPath))) throw new Error("A Steam operation is in progress for this game install.");
    await refreshLaunchTargetBeforeStart(server, { managedHandled: Boolean(server.dockerContainerName) && !isBundledGameProfile(server) });
    if (isBundledGameProfile(server)) await ensureBundledGameContainer(server);
    await ensureGameIntegrationInstalled(server);
    this.phase("starting"); this.rcon.setServerStarting(true);
    this.io?.emit("server:status", { state: "starting", running: false });
    try {
      const managed = await runManagedLifecycle("start", { serverId: this.serverId });
      const result = managed.handled ? managed : await this.manager.startServer({ serverId: this.serverId });
      if (!result.success) throw new Error(result.error || result.message || "Server start failed.");
      await this.waitForState(true, 60000);
      this.io?.emit("server:status", { state: "running-not-ready", running: true });
      // RCON has its own reconnect loop. A verified running process is not a failed restart just because RCON takes longer to boot.
      void this.rcon.connect().catch((error: Error) => log.warn(`Server is running; RCON is not ready: ${error.message}`));
    } finally { this.rcon.setServerStarting(false); }
  }
  private async backupConfig(server: ServerRecord) {
    if (!server.serverName) return;
    const config = server.serverConfigPath || (server.zomboidDataPath ? path.join(server.zomboidDataPath, "Server") : null);
    if (!config) return;
    const ini = candidateIniPaths(config, server.zomboidDataPath ?? null, server.serverName).find(file => fs.existsSync(file));
    if (!ini) return;
    for (const name of [path.basename(ini), `${path.basename(ini, ".ini")}_SandboxVars.lua`]) {
      const backup = await createBackupIfChanged(path.dirname(ini), name);
      if (backup.reason === "failed") throw new Error(`Config backup failed: ${backup.error}`);
    }
  }
  run(options: Options): Promise<MaintenanceResult> {
    if (this.active) return Promise.resolve({ success: false, deferred: true, message: `${this.active.label} is already pending for this server.` });
    const controller = new AbortController(); this.controller = controller;
    this.active = { kind: options.kind, label: options.label, phase: "waiting", startedAt: new Date().toISOString() };
    const promise = runForServer(this.serverId, async () => {
      const signal = controller.signal;
      let lock = options.lifecycleLock || null, wasRunning = false, stopRequested = false;
      let result: MaintenanceResult = { success: false };
      try {
        const initial = await this.state();
        if (initial.running) {
          if (!this.rcon.connected) throw new Error("RCON is required to save and stop a running server.");
          const decision = await this.preparePlayers(options, signal);
          signal.throwIfAborted();
          lock ||= acquireLifecycleLock(options.kind, (await this.profile()).serverName);
          if (!lock) throw new Error("Another lifecycle operation is in progress. Maintenance was deferred.");
          wasRunning = (await this.state()).running;
          if (wasRunning) {
            if (options.automatic && !decision.force && await this.players() > 0) throw new Error("Players joined before the save. Maintenance was deferred.");
            if (options.automatic) await this.players();
            this.phase("saving");
            const saved = await this.rcon.save({ retryOnConnectionError: false });
            if (!saved?.success) throw new Error(`Server save failed. The server was left running: ${saved?.error || "unknown error"}`);
            if (options.automatic && !decision.force && await this.players() > 0) throw new Error("Players joined during the save. Maintenance was deferred.");
            if (options.automatic) await this.players();
            signal.throwIfAborted(); await this.backupConfig(await this.profile());
            this.phase("stopping"); stopRequested = true;
            this.io?.emit("server:status", { state: "stopping", running: true });
            const managed = await runManagedLifecycle("stop", { serverId: this.serverId });
            const stopped = managed.handled ? managed : this.manager.usesManagedServiceLifecycle() ? await this.manager.stopServer(false, { serverId: this.serverId }) : await this.rcon.quit({ retryOnConnectionError: false });
            if (!stopped?.success || stopped.confirmed === false && (managed.handled || this.manager.usesManagedServiceLifecycle())) throw new Error(stopped?.error || stopped?.message || "Server stop failed.");
            await this.waitForState(false, 60000, signal);
            this.manager.markServerStopped?.();
            this.io?.emit("server:status", { state: "stopped", running: false });
          }
        }
        lock ||= acquireLifecycleLock(options.kind, (await this.profile()).serverName);
        if (!lock) throw new Error("Another lifecycle operation is in progress. Maintenance was deferred.");
        signal.throwIfAborted();
        if ((await this.state()).running) throw new Error("Server is running again. Maintenance work was deferred.");
        if (!wasRunning && options.automatic && ["restart", "workshop"].includes(options.kind)) return { success: true, skipped: true, message: "Server is stopped. It will use the updated Workshop content at its next start." };
        this.phase("working");
        result = options.work ? await options.work(signal) : { success: true, message: `${options.label} complete.` };
        if (options.kind === "restart" && !wasRunning && !options.automatic) await this.resumeServer();
      } catch (error) {
        result = { success: false, deferred: !stopRequested, cancelled: signal.aborted, message: (error as Error).message };
      } finally {
        if (stopRequested && wasRunning && (options.kind !== "pz-update" || result.success)) {
          try {
            const state = await this.state();
            if (!state.running) await this.resumeServer();
          } catch (error) { result.success = false; result.message = `${result.backup ? "Backup created, but " : ""}the server could not be restarted safely: ${(error as Error).message}`; }
        }
        lock?.release(); this.active = null; this.controller = null; this.currentRun = null;
        this.io?.emit("maintenance:status", null);
      }
      return result;
    });
    this.currentRun = promise;
    return promise;
  }
}
