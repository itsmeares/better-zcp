import { createLogger } from "../utils/logger.js";
import { getActiveServer, getSetting } from "../database/init.js";
import { getDiskFree } from "../utils/diskSpace.js";

const log = createLogger("DiskMonitor");

export const CHECK_INTERVAL_MS = 60_000;
export const WARNING_PERCENT = 90;
export const CRITICAL_PERCENT = 95;

export async function resolveSaveVolumePath() {
  const activeServer = await getActiveServer();
  if (activeServer?.zomboidDataPath) return activeServer.zomboidDataPath;
  return (await getSetting("zomboidDataPath")) || null;
}

export async function statDisk(targetPath) {
  if (!targetPath) return null;
  try {
    const disk = await getDiskFree(targetPath);
    return disk ? { totalBytes: disk.total, freeBytes: disk.free } : null;
  } catch (err) {
    log.debug(`Disk free check failed for ${targetPath}: ${err.message}`);
    return null;
  }
}

export function computeDiskStatus(targetPath, disk) {
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

export async function getDiskStatusForPath(targetPath) {
  const disk = await statDisk(targetPath);
  return computeDiskStatus(targetPath, disk);
}

export class DiskMonitor {
  constructor(
    io,
    {
      intervalMs = CHECK_INTERVAL_MS,
      resolvePath = resolveSaveVolumePath,
      getStatus = getDiskStatusForPath,
    } = {},
  ) {
    this.io = io;
    this.intervalMs = intervalMs;
    this.resolvePath = resolvePath;
    this.getStatus = getStatus;
    this.timer = null;
    this.status = null;
    this._wasWarning = false;
    this._wasCritical = false;
  }

  async checkNow() {
    const savePath = await this.resolvePath();
    const status = await this.getStatus(savePath);
    this.status = status;
    this._emitIfChanged(status);
    return status;
  }

  _emitIfChanged(status) {
    if (!this.io) return;
    if (!status.ok) {
      return;
    }
    if (status.critical && !this._wasCritical) {
      this.io.emit("disk:critical", status);
    } else if (status.warning && !status.critical && !this._wasWarning) {
      this.io.emit("disk:warning", status);
    } else if (!status.warning && (this._wasWarning || this._wasCritical)) {
      this.io.emit("disk:normal", status);
    }
    this._wasWarning = status.warning;
    this._wasCritical = status.critical;
  }

  getDiskStatus() {
    return this.status;
  }

  start() {
    if (this.timer) return;
    this.checkNow().catch((err) => log.error(`Initial disk check failed: ${err.message}`));
    this.timer = setInterval(() => {
      this.checkNow().catch((err) => log.error(`Disk check failed: ${err.message}`));
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    log.info(`started (checking every ${this.intervalMs / 1000}s)`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
