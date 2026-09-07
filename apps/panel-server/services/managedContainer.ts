import { getActiveServer, getServer } from "../database/init.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("ManagedContainer");

interface DockerContainer {
  State?: { Running?: boolean };
}

interface DockerActionResult {
  success?: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

export interface DockerControl {
  enabled: boolean;
  available: boolean;
  inspectManagedContainer: (
    ref: string,
  ) => Promise<DockerContainer | null>;
  runManagedAction: (
    ref: string,
    action: LifecycleAction,
  ) => Promise<DockerActionResult>;
}

interface ServerProfile {
  id?: string | number;
  isRemote?: boolean;
  dockerContainerName?: unknown;
  dockerContainerId?: unknown;
}

interface ResolveManagedContainerOptions {
  serverId?: string | number | null;
  dockerClient?: DockerControl | null;
}

interface ManagedContainerResolutionUnhandled {
  handled: false;
}

interface ManagedContainerResolutionHandled {
  handled: true;
  ref: string;
  container: DockerContainer | null;
  running?: boolean;
  error?: string;
}

type ManagedContainerResolution =
  | ManagedContainerResolutionUnhandled
  | ManagedContainerResolutionHandled;

interface DockerHostSignal {
  running: boolean;
  scanFailed: boolean;
}

interface LifecycleOptions {
  serverId?: string | number | null;
  dockerClient?: DockerControl | null;
}

type LifecycleAction = "stop" | "start" | "restart";

const containerLifecycleQueues = new WeakMap<
  DockerControl,
  Map<string, Promise<void>>
>();
let sharedDockerClient: DockerControl | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function containerReference(
  server: ServerProfile | null | undefined,
): string | null {
  const name =
    typeof server?.dockerContainerName === "string"
      ? server.dockerContainerName
      : null;
  const id =
    typeof server?.dockerContainerId === "string"
      ? server.dockerContainerId
      : null;
  return name || id;
}

export function setDockerClient(client: DockerControl | null | undefined): void {
  sharedDockerClient = client || null;
}

export function getDockerClient(): DockerControl | null {
  return sharedDockerClient;
}

async function acquireContainerLifecycleLock(
  dockerClient: DockerControl,
  ref: string,
): Promise<() => void> {
  let queues = containerLifecycleQueues.get(dockerClient);
  if (!queues) {
    queues = new Map();
    containerLifecycleQueues.set(dockerClient, queues);
  }

  const previous = queues.get(ref) || Promise.resolve();
  let releaseSignal!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseSignal = resolve;
  });
  queues.set(ref, current);
  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (queues?.get(ref) === current) queues.delete(ref);
    releaseSignal();
  };
}

export async function resolveManagedContainer({
  serverId = null,
  dockerClient = sharedDockerClient,
}: ResolveManagedContainerOptions = {}): Promise<ManagedContainerResolution> {
  if (!dockerClient?.enabled || !dockerClient.available) {
    return { handled: false };
  }

  let server: ServerProfile | null = null;
  try {
    server = (serverId == null
      ? await getActiveServer()
      : await getServer(serverId)) as ServerProfile | null;
  } catch (error: unknown) {
    log.debug(`Could not resolve the server profile: ${errorMessage(error)}`);
    return { handled: false };
  }

  const ref = containerReference(server);
  if (!ref) return { handled: false };

  const container = await dockerClient.inspectManagedContainer(ref);
  if (!container) {
    return {
      handled: true,
      ref,
      container: null,
      error:
        `Container "${ref}" is mapped to this server but the panel cannot manage it. ` +
        `Check that it exists and carries the label zomboid-panel.managed=true.`,
    };
  }

  return {
    handled: true,
    ref,
    container,
    running: container.State?.Running === true,
  };
}

export async function resolveDockerHostSignal(
  server: ServerProfile | null | undefined,
  dockerClient: DockerControl | null | undefined = sharedDockerClient,
): Promise<DockerHostSignal> {
  const containerRef = containerReference(server);
  if (
    containerRef &&
    dockerClient?.enabled &&
    dockerClient.available &&
    typeof dockerClient.inspectManagedContainer === "function"
  ) {
    const container = await dockerClient.inspectManagedContainer(containerRef);
    return container
      ? { running: container.State?.Running === true, scanFailed: false }
      : { running: false, scanFailed: true };
  }

  const managed = await resolveManagedContainer({
    serverId: server?.id,
    dockerClient,
  });
  if (managed.handled) {
    return managed.error
      ? { running: false, scanFailed: true }
      : { running: managed.running === true, scanFailed: false };
  }
  return { running: false, scanFailed: true };
}

export async function runManagedLifecycle(
  action: LifecycleAction,
  {
    serverId = null,
    dockerClient = sharedDockerClient,
  }: LifecycleOptions = {},
): Promise<Record<string, unknown>> {
  if (!dockerClient) return { handled: false };

  const resolved = await resolveManagedContainer({ serverId, dockerClient });
  if (!resolved.handled) return { handled: false };
  if (resolved.error) {
    return { handled: true, success: false, error: resolved.error };
  }

  const release = await acquireContainerLifecycleLock(dockerClient, resolved.ref);
  try {
    const current = await resolveManagedContainer({ serverId, dockerClient });
    if (!current.handled) {
      return {
        handled: true,
        success: false,
        error:
          "Docker control became unavailable while the lifecycle action was waiting",
      };
    }
    if (current.error) {
      return { handled: true, success: false, error: current.error };
    }

    if (action === "stop" && !current.running) {
      return {
        handled: true,
        success: true,
        message: "Container is already stopped",
      };
    }
    if (action === "start" && current.running) {
      return {
        handled: true,
        success: true,
        alreadyRunning: true,
        message: "Container is already running",
      };
    }

    const result = await dockerClient.runManagedAction(current.ref, action);
    log.info(
      `Managed container ${current.ref}: ${action} -> ${result?.success ? "ok" : result?.error || "failed"}`,
    );
    return { handled: true, ...result };
  } finally {
    release();
  }
}
