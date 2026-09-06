import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { createLogger } from "../utils/logger.js";
import { sanitizeError } from "../utils/sanitize.js";
import { getDataPaths } from "../utils/paths.js";
import { getDiskStatusForPath } from "../services/diskMonitor.js";
import { getCircuitBreakerStatus } from "../database/init.js";
import { getRestartAssessment } from "../services/panelUpdateChecker.js";
import { isContainerized } from "../utils/dockerDetect.js";

const log = createLogger("API:System");
const router = express.Router();

export function buildRuntimeInfo({
  platform = process.platform,
  temporaryDirectory = os.tmpdir(),
  environment = process.env,
  pathSeparator = path.sep,
  fileExists = fs.existsSync,
  restartAssessment = getRestartAssessment({
    platform,
    environment,
  }),
} = {}) {
  const family = platform === "win32"
    ? "windows"
    : ["linux", "darwin", "freebsd", "openbsd", "aix", "sunos"].includes(platform)
      ? "posix"
      : "unknown";

  let serviceManager = "unknown";
  if (environment.INVOCATION_ID || environment.NOTIFY_SOCKET) {
    serviceManager = "systemd";
  } else if (environment.RC_SVCNAME) {
    serviceManager = "openrc";
  } else {
    try {
      if (isContainerized(fileExists)) {
        serviceManager = "container";
      } else if (family === "windows" || platform === "darwin") {
        serviceManager = "none";
      }
    } catch {
      // A neutral value is safer than claiming a service manager.
    }
  }

  return {
    platform,
    family,
    pathSeparator,
    temporaryDirectory,
    serviceManager,
    restartAssessment,
  };
}

// No requireRole, deliberately: this is the disk-space/storage-health
// warning the frontend polls dashboard-wide, so every role sees a full
// disk coming before it becomes their problem. Read-only, and error
// messages already run through sanitizeError before leaving this file.

// Combined disk status for both the save volume (polled by DiskMonitor) and
// the panel's own data directory (checked fresh — it's cheap, and its
// disk isn't necessarily the same mount as the save volume).
async function buildDiskSpace(req) {
  const diskMonitor = req.app.get("diskMonitor");
  const saveVolume = diskMonitor ? diskMonitor.getDiskStatus() : null;
  const panelData = await getDiskStatusForPath(getDataPaths().dataDir);
  return { saveVolume, panelData };
}

router.get("/disk-space", async (req, res) => {
  try {
    res.json(await buildDiskSpace(req));
  } catch (error) {
    log.error(`Failed to get disk space: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/runtime", (_req, res) => {
  res.json(buildRuntimeInfo());
});

// Single endpoint the frontend polls: disk space + write circuit breaker
// state, so the UI can warn before a full disk silently drops writes.
router.get("/storage-health", async (req, res) => {
  try {
    const diskSpace = await buildDiskSpace(req);
    const circuitBreaker = getCircuitBreakerStatus();
    res.json({
      diskSpace,
      circuitBreaker: {
        ...circuitBreaker,
        lastError: circuitBreaker.lastError
          ? sanitizeError(circuitBreaker.lastError)
          : null,
      },
    });
  } catch (error) {
    log.error(`Failed to get storage health: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
