import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getActiveServer, getSetting } from "../database/init.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("LogTailer");

interface LogFile {
  path: string;
  mtime: number;
  birthtime: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LogTailer extends EventEmitter {
  userLogPath: string | null = null;
  userLogSize = 0;
  isWatching = false;
  checkTimer: NodeJS.Timeout | null = null;
  logsDir: string | null = null;
  basePath: string | null = null;
  watchStartedAt = Date.now();
  userRemainder = "";

  startOffsetFor(filePath: string, firstDiscovery: boolean): number {
    try {
      const stats = fs.statSync(filePath);
      const born = stats.birthtimeMs || 0;
      if (!firstDiscovery || (born > 0 && born >= this.watchStartedAt)) return 0;
      return stats.size;
    } catch (error) {
      log.debug(`LogTailer: stat failed for ${filePath}: ${errorMessage(error)}`);
      return 0;
    }
  }

  async init(): Promise<void> {
    await this.findLogPath();
    this.startWatching();
  }

  async reloadConfig(): Promise<void> {
    const wasWatching = this.isWatching;
    if (wasWatching) this.stopWatching();

    this.basePath = null;
    this.logsDir = null;
    this.userLogPath = null;
    this.userLogSize = 0;
    this.userRemainder = "";

    await this.findLogPath();
    if (wasWatching) this.startWatching();
  }

  async findLogPath(): Promise<void> {
    try {
      const activeServer = await getActiveServer();
      const homeDir = os.homedir();
      let basePath = process.env.PZ_SAVE_PATH ||
        (homeDir ? path.join(homeDir, "Zomboid") : "");

      if (activeServer?.zomboidDataPath) {
        basePath = activeServer.zomboidDataPath;
      } else {
        const settingPath = await getSetting("zomboidDataPath");
        if (settingPath) basePath = settingPath;
      }

      this.basePath = basePath;
      const logsDir = path.join(basePath, "Logs");
      if (fs.existsSync(logsDir)) {
        this.logsDir = logsDir;
        this.findLatestUserLog();
      }
    } catch (error) {
      log.error(`Error finding log path: ${errorMessage(error)}`);
    }
  }

  private findLatestUserLog(): void {
    if (!this.logsDir) return;
    try {
      const files = fs.readdirSync(this.logsDir)
        .filter((file) => file.endsWith("_user.txt"))
        .map((file): LogFile | null => {
          const filePath = path.join(this.logsDir!, file);
          try {
            const stats = fs.statSync(filePath);
            return {
              path: filePath,
              mtime: stats.mtimeMs,
              birthtime: stats.birthtimeMs,
            };
          } catch {
            return null;
          }
        })
        .filter((file): file is LogFile => file !== null)
        .sort((a, b) => (b.mtime - a.mtime) || (b.birthtime - a.birthtime));

      if (!files.length || files[0].path === this.userLogPath) return;
      const firstDiscovery = !this.userLogPath;
      this.userLogPath = files[0].path;
      this.userRemainder = "";
      this.userLogSize = this.startOffsetFor(files[0].path, firstDiscovery);
      log.info(`Tailing B42 user log: ${files[0].path}`);
    } catch (error) {
      log.debug(`Error scanning user logs: ${errorMessage(error)}`);
    }
  }

  startWatching(): void {
    if (this.isWatching) return;
    this.isWatching = true;
    log.info(`Started watching player events (${this.userLogPath || "no user log yet"})`);
    void this.checkLoop();
  }

  stopWatching(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = null;
    this.isWatching = false;
  }

  private async checkLoop(): Promise<void> {
    if (!this.isWatching) return;
    await this.checkUserLog();
    if (this.isWatching) {
      this.checkTimer = setTimeout(() => void this.checkLoop(), 2000);
    }
  }

  async checkUserLog(): Promise<void> {
    if (this.logsDir) this.findLatestUserLog();
    if (!this.userLogPath) return;

    try {
      const stats = await fs.promises.stat(this.userLogPath);
      if (stats.size < this.userLogSize) {
        this.userLogSize = 0;
        this.userRemainder = "";
        return;
      }
      if (stats.size === this.userLogSize) return;

      const bytesToRead = stats.size - this.userLogSize;
      if (bytesToRead > 1024 * 1024) {
        log.warn(`User log grew by ${Math.round(bytesToRead / 1024)}KB since the last poll — skipping the burst`);
        this.userLogSize = stats.size;
        this.userRemainder = "";
        return;
      }

      const data = await this.readChunk(this.userLogPath, this.userLogSize, stats.size);
      this.userLogSize = stats.size;
      if (data) this.processUserLogData(data);
    } catch (error) {
      log.debug(`LogTailer: user log polling error: ${errorMessage(error)}`);
    }
  }

  private readChunk(filePath: string, start: number, end: number): Promise<string | null> {
    return new Promise((resolve) => {
      if (end <= start) return resolve(null);
      const stream = fs.createReadStream(filePath, { start, end: end - 1 });
      let data = "";
      stream.on("data", (chunk) => { data += chunk.toString(); });
      stream.on("end", () => resolve(data));
      stream.on("error", () => resolve(null));
    });
  }

  processUserLogData(data: string): void {
    const lines = (this.userRemainder + data).split(/\r?\n/);
    this.userRemainder = lines.pop() ?? "";
    if (this.userRemainder.length > 64 * 1024) this.userRemainder = "";

    for (const line of lines) {
      const match = line.trim().match(
        /user\s+(.+?)\s+died at\s+\((-?\d+),(-?\d+),(-?\d+)\)\s*(?:\((non\s*pvp|pvp)\))?/i,
      );
      if (!match) continue;
      const x = Number.parseInt(match[2], 10);
      const y = Number.parseInt(match[3], 10);
      const z = Number.parseInt(match[4], 10);
      this.emit("playerDeath", {
        player: match[1],
        x,
        y,
        z,
        pvp: (match[5] || "").toLowerCase() === "pvp",
        location: `${x},${y},${z}`,
        timestamp: new Date(),
      });
    }
  }
}
