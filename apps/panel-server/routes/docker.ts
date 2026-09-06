import express from "express";
import { requirePermission } from "../services/permissions.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.ts";
import { getServer } from "../database/init.js";
import { RconService } from "../services/rcon.js";
import { ErrorCode } from "../utils/errorCodes.ts";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "../services/lifecycleCoordinator.ts";

const router = express.Router();

interface ManagedDockerContainer {
  Id: string;
  Names?: string[];
  Image?: string;
  State?: { Running?: boolean };
  Status?: string;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

router.get("/status", requirePermission("docker.manage"), async (req, res) => {
  try {
    const dockerClient = req.app.get("dockerClient");
    if (!dockerClient?.enabled) {
      return res.json({ enabled: false, available: false, containers: [] });
    }
    const containers = (await dockerClient.listManagedContainers()) as
      ManagedDockerContainer[];
    return res.json({
      enabled: true,
      available: dockerClient.available,
      ...(dockerClient.lastError ? { error: sanitizeError(dockerClient.lastError) } : {}),
      containers: containers.map((container) => ({
        id: container.Id,
        name: (container.Names?.[0] || "").replace(/^\//, ""),
        image: container.Image,
        state: container.State,
        status: container.Status,
      })),
    });
  } catch (error: unknown) {
    return res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/stats", requirePermission("docker.manage"), async (req, res) => {
  try {
    const dockerClient = req.app.get("dockerClient");
    if (!dockerClient?.enabled || !dockerClient.available) return res.json({ containers: {} });
    const containers = (await dockerClient.listManagedContainers()) as
      ManagedDockerContainer[];
    const samples = await mapWithConcurrency(containers, 3, async (container) => ({
      container,
      stats: await dockerClient.getContainerStats(container.Id),
    }));
    const result: Record<string, unknown> = {};
    for (const { container, stats } of samples) {
      if (!stats) continue;
      result[container.Id] = stats;
      const name = (container.Names?.[0] || "").replace(/^\//, "");
      if (name) result[name] = stats;
    }
    return res.json({ containers: result });
  } catch (error: unknown) {
    return res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/containers/:id/:action", requirePermission("docker.manage"), async (req, res) => {
  const lifecycleLock = acquireLifecycleLock(
    `docker-${req.params.action}`,
    req.params.id || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  let rconService = null;
  try {
    const dockerClient = req.app.get("dockerClient");
    if (!dockerClient?.enabled || !dockerClient.available) {
      return res.status(503).json({
        error: "Docker control is unavailable",
        code: ErrorCode.DOCKER_UNAVAILABLE,
      });
    }
    const server = await getServer(req.body?.serverId);
    if (!server) {
      return res.status(404).json({
        error: "Server profile not found",
        code: ErrorCode.SERVER_PROFILE_NOT_FOUND,
      });
    }
    if (
      server.dockerContainerName !== req.params.id &&
      server.dockerContainerId !== req.params.id
    ) {
      return res.status(403).json({
        error: "Container is not mapped to this server",
        code: ErrorCode.CONTAINER_NOT_MAPPED,
      });
    }
    const container = await dockerClient.inspectManagedContainer(req.params.id);
    if (!container) {
      return res.status(403).json({
        error: "Container is not managed by this panel",
        code: ErrorCode.CONTAINER_NOT_MANAGED,
      });
    }
    if (["stop", "restart"].includes(req.params.action) && container.State?.Running) {
      rconService = new RconService();
      await rconService.loadConfig(server.id);
      if (!(await rconService.connect())) {
        return res.status(409).json({
          error: "RCON connection failed; container was not changed",
          code: ErrorCode.DOCKER_ACTION_RCON_CONNECT_FAILED,
        });
      }
      const saved = await rconService.save({ skipLog: true });
      if (!saved?.success) {
        const reason = saved?.error || "unknown error";
        return res.status(409).json({
          error: `World save failed: ${reason}`,
          code: ErrorCode.DOCKER_ACTION_SAVE_FAILED,
          params: sanitizeErrorParams({ reason }),
        });
      }
    }
    const result = await dockerClient.runManagedAction(req.params.id, req.params.action);
    if (!result.success) {
      return res.status(403).json({ ...result, error: sanitizeError(result.error) });
    }
    return res.json(result);
  } catch (error: unknown) {
    return res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  } finally {
    if (rconService?.connected) {
      await rconService.disconnect().catch(() => {});
    }
    lifecycleLock.release();
  }
});

export default router;
