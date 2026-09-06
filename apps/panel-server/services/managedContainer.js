import { getActiveServer, getServer } from "../database/init.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ManagedContainer");

let sharedDockerClient = null;
const containerLifecycleQueues = new WeakMap();

export function setDockerClient(client) {
  sharedDockerClient = client || null;
}

export function getDockerClient() {
  return sharedDockerClient;
}

async function acquireContainerLifecycleLock(dockerClient, ref) {
  let queues = containerLifecycleQueues.get(dockerClient);
  if (!queues) {
    queues = new Map();
    containerLifecycleQueues.set(dockerClient, queues);
  }

  const previous = queues.get(ref) || Promise.resolve();
  let releaseSignal;
  const current = new Promise((resolve) => {
    releaseSignal = resolve;
  });
  queues.set(ref, current);
  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (queues.get(ref) === current) queues.delete(ref);
    releaseSignal();
  };
}

export async function resolveManagedContainer({
  serverId = null,
  dockerClient = sharedDockerClient,
} = {}) {
  if (!dockerClient?.enabled || !dockerClient.available) return { handled: false };

  let server = null;
  try {
    server = serverId == null ? await getActiveServer() : await getServer(serverId);
  } catch (error) {
    log.debug(`Could not resolve the server profile: ${error.message}`);
    return { handled: false };
  }

  const ref = server?.dockerContainerName || server?.dockerContainerId || null;
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
  server,
  dockerClient = sharedDockerClient,
) {
  const containerRef = server?.dockerContainerName || server?.dockerContainerId;
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
  action,
  { serverId = null, dockerClient = sharedDockerClient } = {},
) {
  const resolved = await resolveManagedContainer({ serverId, dockerClient });
  if (!resolved.handled) return { handled: false };
  if (resolved.error) return { handled: true, success: false, error: resolved.error };

  const release = await acquireContainerLifecycleLock(dockerClient, resolved.ref);
  try {
    const current = await resolveManagedContainer({ serverId, dockerClient });
    if (!current.handled) {
      return {
        handled: true,
        success: false,
        error: "Docker control became unavailable while the lifecycle action was waiting",
      };
    }
    if (current.error) {
      return { handled: true, success: false, error: current.error };
    }

    if (action === "stop" && !current.running) {
      return { handled: true, success: true, message: "Container is already stopped" };
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
