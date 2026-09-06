/**
 * Routes server lifecycle actions to Docker when the target server is mapped
 * to a managed container.
 *
 * Why this exists: RCON `quit` and `serverManager.stopServer()` both act on the
 * *process*. Inside a container that process is PID 1, so killing it exits the
 * container — and a `restart: always` / `unless-stopped` policy immediately
 * brings the world back up. From the operator's seat the Stop button looks
 * broken. `docker stop` is a *manual* stop, which Docker exempts from restart
 * policies, so it is the only shutdown that actually sticks.
 *
 * Every caller keeps its own RCON save + guards; this module only decides who
 * owns the lifecycle action and performs the Docker half.
 */
import { getActiveServer, getServer } from "../database/init.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ManagedContainer");

// Wired once from index.js. Routes may still pass an explicit client.
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

/**
 * @returns {Promise<{handled: boolean, ref?: string, container?: object|null,
 *   running?: boolean, error?: string}>}
 *   `handled: false` means no managed container owns this server — the caller
 *   must fall back to its existing RCON/process path.
 */
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
    // Fail closed. Falling back to RCON here would kill the game process and
    // let the container's restart policy bring it straight back up — the exact
    // failure this module exists to prevent.
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

/**
 * Docker-aware "is the host up" signal for docker-local/docker-managed
 * providers. Callers must already know the server IS a Docker provider
 * (see resolveProvider() in apps/panel-server/utils/serverStatusModel.js) -- this
 * does not check that itself, and a native/systemd/openrc/remote server
 * passed in here would just fall through to the resolveManagedContainer()
 * branch and report `scanFailed: true` (no container ref to look up).
 *
 * Mirrors the two Docker paths apps/panel-server/routes/serverStatus.js's GET
 * /active/status route used to inline directly, kept here as the ONE
 * implementation so that route's dashboard badge and the status watchdog
 * (apps/panel-server/index.js's checkServerStatusNow) can never drift out of sync on
 * what "Docker says running" means for the same server at the same
 * moment. Both paths ultimately call dockerClient.inspectManagedContainer(),
 * which unconditionally requires the zomboid-panel.managed=true label
 * itself (see isManagedContainer() above) -- there is no unlabeled-container
 * path. The two branches differ only in HOW the container ref is found:
 *  - if the given `server` already carries a usable ref (dockerContainerName
 *    /dockerContainerId) and dockerClient looks usable, inspect it directly.
 *  - otherwise fall through to resolveManagedContainer(), which re-resolves
 *    the server record itself (by id) and produces a more specific error
 *    when Docker control is off/unavailable or nothing is mapped.
 *
 * @returns {Promise<{running: boolean, scanFailed: boolean}>} scanFailed
 *   true means "could not verify" (Docker control off/unavailable, the
 *   lookup itself failed, or a mapped container/ref that no longer
 *   resolves) -- callers must treat that as unknown, never as a confident
 *   "stopped" (GH#114: PZ runs as PID 1 of a *different* container here,
 *   so there is no local fallback that could ever safely stand in).
 */
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

/**
 * @param {"start"|"stop"|"restart"} action
 * @returns {Promise<{handled: boolean, success?: boolean, message?: string, error?: string}>}
 */
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
