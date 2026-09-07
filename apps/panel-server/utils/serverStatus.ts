import { getActiveServer } from "../database/init.ts";
import { resolveProvider } from "./serverStatusModel.ts";
import {
  resolveDockerHostSignal,
  type DockerControl,
} from "../services/managedContainer.ts";
import panelBridge from "../services/panelBridge.ts";

interface ObservedSignals {
  processRunning?: boolean;
  rconConnected?: boolean;
  bridgeConnected?: boolean;
  processScanFailed?: boolean;
  hostStateAuthoritative?: boolean;
}

interface ProcessDetails {
  running?: boolean;
  scanFailed?: boolean;
}

interface ServerManagerLike {
  isRunning?: boolean;
  getServerProcessDetails?: () => Promise<ProcessDetails | null>;
}

interface RconServiceLike {
  connected?: boolean;
}

interface ActiveServerLike {
  isRemote?: boolean;
  provider?: string | null;
  dockerContainerId?: unknown;
  dockerContainerName?: unknown;
  lifecycleProvider?: string | null;
}

export function isServerObservedRunning({
  processRunning = false,
  rconConnected = false,
  bridgeConnected = false,
  processScanFailed = false,
  hostStateAuthoritative = false,
}: ObservedSignals = {}): boolean | null {
  if (hostStateAuthoritative && !processScanFailed) {
    return Boolean(processRunning);
  }
  if (processScanFailed && !rconConnected && !bridgeConnected) return null;
  return Boolean(processRunning || rconConnected || bridgeConnected);
}

export async function resolveObservedServerRunning(
  serverManager: ServerManagerLike | null | undefined,
  rconService: RconServiceLike | null | undefined,
  dockerClient: DockerControl | null | undefined = null,
): Promise<boolean | null> {
  const activeServer = (await getActiveServer()) as ActiveServerLike | null;
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
      !processDetails?.scanFailed &&
      !["systemd", "openrc"].includes(activeServer?.lifecycleProvider ?? ""),
  });
}
