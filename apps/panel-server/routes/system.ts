import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { createLogger } from "../utils/logger.js";
import { sanitizeError } from "../utils/sanitize.ts";
import { getDataPaths } from "../utils/paths.js";
import { getDiskStatusForPath } from "../services/diskMonitor.ts";
import { getCircuitBreakerStatus } from "../database/init.js";
import { getRestartAssessment } from "../services/panelUpdateChecker.js";
import { isContainerized } from "../utils/dockerDetect.ts";

const log = createLogger("API:System");
const router = express.Router();

interface RuntimeInfoOptions {
  platform?: string;
  temporaryDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  pathSeparator?: string;
  fileExists?: (path: fs.PathLike) => boolean;
  restartAssessment?: ReturnType<typeof getRestartAssessment>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildRuntimeInfo({
  platform = process.platform,
  temporaryDirectory = os.tmpdir(),
  environment = process.env,
  pathSeparator = path.sep,
  fileExists = fs.existsSync,
  restartAssessment = getRestartAssessment({
    platform: platform as NodeJS.Platform,
    environment,
  }),
}: RuntimeInfoOptions = {}): {
  platform: string;
  family: string;
  pathSeparator: string;
  temporaryDirectory: string;
  serviceManager: string;
  restartAssessment: ReturnType<typeof getRestartAssessment>;
} {
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


async function buildDiskSpace(req: express.Request) {
  const diskMonitor = req.app.get("diskMonitor");
  const saveVolume = diskMonitor ? diskMonitor.getDiskStatus() : null;
  const panelData = await getDiskStatusForPath(getDataPaths().dataDir);
  return { saveVolume, panelData };
}

router.get("/disk-space", async (req, res) => {
  try {
    res.json(await buildDiskSpace(req));
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to get disk space: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
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
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to get storage health: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

export default router;
