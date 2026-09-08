import path from "path";

export function getRestartAssessment({
  platform = process.platform,
  packaged = typeof (process as NodeJS.Process & { pkg?: unknown }).pkg !== "undefined",
  environment = process.env,
  exeDir = path.dirname(process.execPath),
  launcherProtected =
    environment.PANEL_SUPERVISOR_V === "2" &&
    environment.PANEL_PRESERVE_GAME_SERVERS === "1",
}: {
  platform?: string;
  packaged?: boolean;
  environment?: NodeJS.ProcessEnv;
  exeDir?: string;
  launcherProtected?: boolean;
} = {}) {
  const orchestrated = Boolean(
    environment.INVOCATION_ID || environment.NOTIFY_SOCKET || environment.RC_SVCNAME,
  );

  if (!packaged) {
    return {
      gameServers: "unknown",
      requiresConfirmation: true,
      reason: "development-runtime",
    };
  }
  if (platform === "win32") {
    return {
      gameServers: "preserved",
      requiresConfirmation: false,
      reason: "detached-windows-process",
    };
  }
  if (platform === "linux" && orchestrated && launcherProtected) {
    return {
      gameServers: "preserved",
      requiresConfirmation: false,
      reason: "isolated-linux-supervisor",
    };
  }
  if (platform === "linux" && orchestrated) {
    return {
      gameServers: "at-risk",
      requiresConfirmation: true,
      reason: "service-cgroup-may-stop-children",
      remediationCommand: `sudo ${path.join(exeDir, "install-linux-service.sh")} --enable`,
    };
  }
  return {
    gameServers: platform === "linux" ? "preserved" : "unknown",
    requiresConfirmation: platform !== "linux",
    reason: platform === "linux" ? "detached-linux-process" : "unknown-runtime",
  };
}
