import { createLogger } from "../utils/logger.ts";
import { getActiveServer, getSetting } from "../database/init.js";
import { getDiskFree } from "../utils/diskSpace.ts";

type DiskReading = { total: number; free: number };
type DiskStatus = {
  path: string | null;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
  warning: boolean;
  critical: boolean;
  ok: boolean;
};
type DiskMonitorIo = { emit: (event: string, status: DiskStatus) => void };
type DiskMonitorOptions = {
  intervalMs?: number;
  resolvePath?: () => string | null | Promise<string | null>;
  getStatus?: (targetPath: string | null) => DiskStatus | Promise<DiskStatus>;
};

const log = createLogger("DiskMonitor");

export const CHECK_INTERVAL_MS = 60_000;
export const WARNING_PERCENT = 90;
export const CRITICAL_PERCENT = 95;

export async function resolveSaveVolumePath(): Promise<string | null> {
  const activeServer = await getActiveServer();
  if (activeServer?.zomboidDataPath) return activeServer.zomboidDataPath as string;
  return ((await getSetting("zomboidDataPath")) || null) as string | null;
}

export async function statDisk(
  targetPath: string | null | undefined,
): Promise<{ totalBytes: number; freeBytes: number } | null> {
  if (!targetPath) return null;
  try {
    const disk = (await getDiskFree(targetPath)) as DiskReading | null;
    return disk ? { totalBytes: disk.total, freeBytes: disk.free } : null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.debug(`Disk free check failed for ${targetPath}: ${message}`);
    return null;
  }
}

export function computeDiskStatus(
  targetPath: string | null | undefined,
  disk: { totalBytes: number; freeBytes: number } | null,
): DiskStatus {
  if (!targetPath || !disk || !disk.totalBytes) {
    return {
      path: targetPath || null,
      totalBytes: 0,
      freeBytes: 0,
      usedPercent: 0,
      warning: false,
      critical: false,
      ok: false,
    };
  }
  const usedPercent =
    Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 1000) / 10;
  return {
    path: targetPath,
    totalBytes: disk.totalBytes,
    freeBytes: disk.freeBytes,
    usedPercent,
    warning: usedPercent >= WARNING_PERCENT,
    critical: usedPercent >= CRITICAL_PERCENT,
    ok: true,
  };
}

export async function getDiskStatusForPath(
  targetPath: string | null | undefined,
): Promise<DiskStatus> {
  const disk = await statDisk(targetPath);
  return computeDiskStatus(targetPath, disk);
}

export class DiskMonitor {
  private readonly io: DiskMonitorIo | null | undefined;
  private readonly intervalMs: number;
  private readonly resolvePath: () => string | null | Promise<string | null>;
  private readonly getStatus: (
    targetPath: string | null,
  ) => DiskStatus | Promise<DiskStatus>;
  private timer: NodeJS.Timeout | null = null;
  private status: DiskStatus | null = null;
  private wasWarning = false;
  private wasCritical = false;

  constructor(io: DiskMonitorIo | null | undefined, options: DiskMonitorOptions = {}) {
    this.io = io;
    this.intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
    this.resolvePath = options.resolvePath ?? resolveSaveVolumePath;
    this.getStatus = options.getStatus ?? getDiskStatusForPath;
  }

  async checkNow(): Promise<DiskStatus> {
    const savePath = await this.resolvePath();
    const status = await this.getStatus(savePath);
    this.status = status;
    this.emitIfChanged(status);
    return status;
  }

  private emitIfChanged(status: DiskStatus): void {
    if (!this.io || !status.ok) return;
    if (status.critical && !this.wasCritical) {
      this.io.emit("disk:critical", status);
    } else if (status.warning && !status.critical && !this.wasWarning) {
      this.io.emit("disk:warning", status);
    } else if (!status.warning && (this.wasWarning || this.wasCritical)) {
      this.io.emit("disk:normal", status);
    }
    this.wasWarning = status.warning;
    this.wasCritical = status.critical;
  }

  getDiskStatus(): DiskStatus | null {
    return this.status;
  }

  start(): void {
    if (this.timer) return;
    this.checkNow().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Initial disk check failed: ${message}`);
    });
    this.timer = setInterval(() => {
      this.checkNow().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Disk check failed: ${message}`);
      });
    }, this.intervalMs);
    this.timer.unref?.();
    log.info(`started (checking every ${this.intervalMs / 1000}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
