import { getPanelRuntime } from "../utils/panelRuntime.ts";
import { getCurrentServer } from "../database/init.ts";
import { resolveProvider } from "./serverStatusModel.ts";
import {
  resolveDockerHostSignal,
  type DockerControl,
} from "../services/managedContainer.ts";

interface ObservedSignals {
  processRunning?: boolean;
  rconConnected?: boolean;
  gameIntegrationConnected?: boolean;
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
  provider?: string | null;
  dockerContainerId?: unknown;
  dockerContainerName?: unknown;
  lifecycleProvider?: string | null;
}

export function isServerObservedRunning({
  processRunning = false,
  rconConnected = false,
  gameIntegrationConnected = false,
  processScanFailed = false,
  hostStateAuthoritative = false,
}: ObservedSignals = {}): boolean | null {
  if (hostStateAuthoritative && !processScanFailed) {
    return Boolean(processRunning);
  }
  if (processScanFailed && !rconConnected && !gameIntegrationConnected) return null;
  return Boolean(processRunning || rconConnected || gameIntegrationConnected);
}

export async function resolveObservedServerRunning(
  serverManager: ServerManagerLike | null | undefined,
  rconService: RconServiceLike | null | undefined,
  dockerClient: DockerControl | null | undefined = null,
): Promise<boolean | null> {
  const activeServer = (await getCurrentServer()) as ActiveServerLike | null;
  const provider = resolveProvider(activeServer);
  if (provider === "docker-local" || provider === "docker-managed") {
    const dockerSignal = await resolveDockerHostSignal(activeServer, dockerClient);
    return isServerObservedRunning({
      processRunning: dockerSignal.running,
      rconConnected: rconService?.connected,
      gameIntegrationConnected: getPanelRuntime().gameIntegration.isConnected(),
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
    gameIntegrationConnected: getPanelRuntime().gameIntegration.isConnected(),
    processScanFailed: !processDetails || processDetails.scanFailed,
    hostStateAuthoritative:
      Boolean(processDetails) &&
      !processDetails?.scanFailed &&
      !["systemd", "openrc"].includes(activeServer?.lifecycleProvider ?? ""),
  });
}
