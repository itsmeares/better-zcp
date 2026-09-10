import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRestartAssessment } from "../services/runtimeInfo.ts";
import { isContainerized } from "./dockerDetect.ts";

export interface RuntimeInfoOptions {
  platform?: string;
  temporaryDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  pathSeparator?: string;
  fileExists?: (path: fs.PathLike) => boolean;
  restartAssessment?: ReturnType<typeof getRestartAssessment>;
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
