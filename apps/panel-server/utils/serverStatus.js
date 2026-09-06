import { getActiveServer } from "../database/init.js";
import { resolveProvider } from "./serverStatusModel.js";
import { resolveDockerHostSignal } from "../services/managedContainer.js";
import panelBridge from "../services/panelBridge.js";

export function isServerObservedRunning({
  processRunning = false,
  rconConnected = false,
  bridgeConnected = false,
  processScanFailed = false,
  hostStateAuthoritative = false,
} = {}) {
  if (hostStateAuthoritative && !processScanFailed) {
    return Boolean(processRunning);
  }
  if (processScanFailed && !rconConnected && !bridgeConnected) return null;
  return Boolean(processRunning || rconConnected || bridgeConnected);
}

export async function resolveObservedServerRunning(serverManager, rconService, dockerClient) {
  const activeServer = await getActiveServer();
  if (activeServer?.isRemote) {
    return isServerObservedRunning({
      processRunning: false,
      rconConnected: rconService?.connected,
      bridgeConnected: panelBridge.isModConnected(),
    });
  }

  const provider = resolveProvider(activeServer);
  if (provider === "docker-local" || provider === "docker-managed") {
    const dockerSignal = await resolveDockerHostSignal(activeServer, dockerClient);
    return isServerObservedRunning({
      processRunning: dockerSignal.running,
      rconConnected: rconService?.connected,
      bridgeConnected: panelBridge.isModConnected(),
      processScanFailed: dockerSignal.scanFailed,
      hostStateAuthoritative: !dockerSignal.scanFailed,
    });
  }

  const processDetails =
    typeof serverManager?.getServerProcessDetails === "function"
      ? await serverManager.getServerProcessDetails()
      : null;

  return isServerObservedRunning({
    processRunning: processDetails?.running,
    rconConnected: rconService?.connected,
    bridgeConnected: panelBridge.isModConnected(),
    processScanFailed: !processDetails || processDetails.scanFailed,
    hostStateAuthoritative:
      Boolean(processDetails) &&
      !processDetails.scanFailed &&
      !["systemd", "openrc"].includes(activeServer?.lifecycleProvider),
  });
}
