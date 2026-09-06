import { createLogger } from "../utils/logger.js";
import { getActiveServer, getSetting } from "../database/init.js";
import { getDiskFree } from "../utils/diskSpace.js";

const log = createLogger("DiskMonitor");

export const CHECK_INTERVAL_MS = 60_000;
export const WARNING_PERCENT = 90;
export const CRITICAL_PERCENT = 95;

/**
 * Resolve the save volume path to monitor: the active server's
 * zomboidDataPath (where PZ writes chunk saves), falling back to the
 * legacy flat setting for pre-multi-server installs. Any path within the
 * mount works for a free-space check — we don't need the deeper
 * Saves/Multiplayer resolution that chunk browsing uses.
 */
export async function resolveSaveVolumePath() {
  const activeServer = await getActiveServer();
  if (activeServer?.zomboidDataPath) return activeServer.zomboidDataPath;
  return (await getSetting("zomboidDataPath")) || null;
}

/**
 * Read free/total bytes for the filesystem containing `targetPath`.
 * Returns null if the path is missing, unreachable, or the platform check
 * failed — callers must treat null as "unknown", not zero, so a stat
 * failure never fakes a 0%-used disk.
 */
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

/** Pure: turn a raw {totalBytes, freeBytes} reading into the status shape. */
export function computeDiskStatus(targetPath, disk) {
  if (!targetPath || !disk || !disk.totalBytes) {
    return {
      path: targetPath || null,
      totalBytes: 0,
      freeBytes: 0,
      usedPercent: 0,
      warning: false,
      critical: false,
      // Distinguishes "we genuinely don't know" (no path configured, or the
      // stat itself failed -- unreachable mount, permission error) from a
      // real, healthy, near-empty disk. Both used to collapse to this same
      // zeroed shape, so the one feature that exists to warn before a full
      // disk breaks writes went silently inert exactly when its target
      // volume became unreachable.
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

/** Fresh, on-demand disk status for an arbitrary path (e.g. the panel's own data dir). */
export async function getDiskStatusForPath(targetPath) {
  const disk = await statDisk(targetPath);
  return computeDiskStatus(targetPath, disk);
}

/**
 * Polls the active server's save volume on an interval and emits Socket.IO
 * events when the warning/critical thresholds are crossed (edge-triggered —
 * not re-emitted every tick while a level holds steady).
 */
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
      // Can't verify disk health right now (unreachable mount, permission
      // error, no path configured) -- neither claim recovery nor overwrite
      // the last known alert state. Preserving _wasWarning/_wasCritical
      // means a critical banner stays up through an unreadable stretch
      // instead of silently reporting normal, and the correct transition
      // still fires once a trustworthy reading comes back.
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
