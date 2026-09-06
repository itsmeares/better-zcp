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
import { isContainerized } from "../utils/dockerDetect.ts";

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
