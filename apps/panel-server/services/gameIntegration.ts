import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.ts";
import { readRegularFile } from "../utils/regularFile.ts";

export const GAME_COMMANDS = new Set([
  "ping", "getAllSandboxOptions", "setSandboxOption", "healPlayer",
  "killPlayer", "getItemCatalog",
]);

export type GameSnapshot = {
  protocol: number;
  supported?: boolean;
  version: string;
  session: string;
  serverName: string;
  playerCount: number;
  players: string[];
  playerDetails: Record<string, any>[];
  world: Record<string, any>;
};

export class GameIntegration extends EventEmitter {
  path: string | null = null;
  isRunning = false;
  snapshot: GameSnapshot | null = null;
  private serverName = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSeen = 0;
  private startedAt = 0;
  private connected = false;
  private generation = 0;
  private queued = 0;
  private pending: { id: string; session: string; resolve: (data: any) => void; reject: (error: Error) => void } | null = null;

  start(directory: string, serverName: string): void {
    if (!path.isAbsolute(directory) || !/^[A-Za-z0-9_ -]{1,64}$/.test(serverName)) {
      throw new Error("Invalid configured game integration path or server name.");
    }
    this.stop();
    this.path = directory;
    this.serverName = serverName;
    this.isRunning = true;
    this.startedAt = Date.now();
    this.poll();
    this.timer = setInterval(() => this.poll(), 250);
    this.timer.unref();
    this.emit("status", this.getStatus());
  }

  stop(): void {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.pending?.reject(new Error("Game integration stopped. The command result is unknown; do not retry automatically."));
    this.pending = null;
    this.snapshot = null;
    this.lastSeen = 0;
    this.connected = false;
    this.isRunning = false;
    this.path = null;
    this.emit("status", this.getStatus());
  }

  isConnected(): boolean {
    return this.isRunning && !!this.snapshot && this.snapshot.supported !== false && this.lastSeen >= this.startedAt && Date.now() - this.lastSeen >= 0 && Date.now() - this.lastSeen < 45000;
  }

  getStatus() {
    const connected = this.isConnected();
    const summary = connected ? "Game integration connected." : "Start the server with the game integration installed. Waiting for a fresh heartbeat.";
    return {
      configured: !!this.path,
      isRunning: this.isRunning,
      modConnected: connected,
      path: this.path,
      modStatus: this.snapshot ? { ...this.snapshot, alive: connected, age: Date.now() - this.lastSeen } : null,
      connection: { healthy: connected, canSendCommands: connected, summary, issues: connected ? [] : [summary] },
    };
  }

  private read(file: string): any {
    return JSON.parse(readRegularFile(file, 4 * 1024 * 1024));
  }

  private poll(): void {
    if (!this.isRunning || !this.path) return;
    try {
      const file = path.join(this.path, "status.json.txt");
      const modified = fs.statSync(file).mtimeMs;
      if (modified !== this.lastSeen) {
        const snapshot = this.read(file);
        if (snapshot.protocol !== 1 || typeof snapshot.session !== "string" || !snapshot.session || snapshot.session.length > 128 || snapshot.serverName !== this.serverName || typeof snapshot.version !== "string" || !Array.isArray(snapshot.players) || snapshot.players.some((name: unknown) => typeof name !== "string") || !Array.isArray(snapshot.playerDetails) || snapshot.playerDetails.some((player: any) => !player || typeof player.username !== "string") || !Number.isInteger(snapshot.playerCount) || snapshot.playerCount < 0 || !snapshot.world || typeof snapshot.world !== "object") {
          throw new Error("Invalid game integration heartbeat.");
        }
        if (this.pending && this.pending.session !== snapshot.session) {
          this.pending.reject(new Error("The game restarted before the command was confirmed. Do not retry automatically."));
        }
        this.snapshot = snapshot;
        this.lastSeen = modified;
        this.emit("snapshot", { ...snapshot, alive: this.isConnected() });
      }
    } catch {
      // PZ writes its files in place. Keep the previous snapshot during an incomplete write, but let it expire.
    }
    const connected = this.isConnected();
    if (this.connected !== connected) {
      this.connected = connected;
      this.emit("status", this.getStatus());
    }
    if (!this.pending) return;
    try {
      const result = this.read(path.join(this.path, "response.json.txt"));
      if (result.protocol !== 1 || result.id !== this.pending.id || result.session !== this.pending.session) return;
      if (result.success === true) this.pending.resolve({ success: true, data: result.data });
      else if (result.success === false) this.pending.reject(Object.assign(new Error(result.error || "Game command failed."), { data: result.data }));
    } catch {
      // Missing or partially written responses are retried by the next poll, never by resending an action.
    }
  }

  async sendCommand(action: string, args: Record<string, unknown> = {}): Promise<any> {
    if (!GAME_COMMANDS.has(action)) throw new Error("Unsupported game integration action.");
    if (["healPlayer", "killPlayer"].includes(action)) {
      if (typeof args.username !== "string" || !args.username.trim() || !/^[^\x00-\x1F\x7F"\\]{1,64}$/.test(args.username)) {
        throw Object.assign(new Error("Invalid player username."), { status: 400 });
      }
    }
    if (["healPlayer", "killPlayer"].includes(action) && this.isConnected() && !this.snapshot!.players.includes(args.username as string)) {
      throw Object.assign(new Error("Player is not online."), { status: 404 });
    }
    if (this.queued >= 8) throw new Error("Game integration is busy. Wait for the current actions to finish.");
    if (!this.path || !this.isConnected()) throw new Error("Game integration is not connected.");
    const directory = this.path;
    const request = path.join(directory, "request.json");
    const generation = this.generation;
    const expiresAt = Date.now() + 15000;
    this.queued++;
    try {
      // ponytail: one mailbox per game, serialized commands; use a queue only if concurrent game actions become necessary.
      return await withFileLock(request, async () => {
        if (generation !== this.generation || !this.isConnected()) throw new Error("Game integration is not connected.");
        if (Date.now() >= expiresAt) throw new Error("Game command expired before it could be sent.");
        const id = randomUUID();
        const session = this.snapshot!.session;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          return await new Promise((resolve, reject) => {
            this.pending = { id, session, resolve, reject };
            timeout = setTimeout(() => reject(new Error("Game command timed out. Its result is unknown; check the player before retrying.")), expiresAt - Date.now());
            try {
              writeFileAtomic(request, JSON.stringify({ id, session, action, args, expiresAt }), { encoding: "utf8", mode: 0o600 });
            } catch (error) { reject(error); }
          });
        } finally {
          if (timeout) clearTimeout(timeout);
          if (this.pending?.id === id) this.pending = null;
          // Never leave an unconfirmed action behind for a later game tick or another panel process.
          try {
            if (this.read(request).id === id) fs.unlinkSync(request);
          } catch { /* The game or shutdown may have already removed it. */ }
        }
      });
    } finally { this.queued--; }
  }
}
