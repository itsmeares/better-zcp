import fs from "node:fs";
import http from "node:http";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("DockerClient");
const MANAGED_LABEL = "zomboid-panel.managed";
const REQUEST_TIMEOUT_MS = 5000;
const LIFECYCLE_GRACE_MS = 30000;
const DEFAULT_STOP_TIMEOUT_SEC = 10;
const DEFAULT_LOG_TAIL_LINES = 500;
const MAX_LOG_RESPONSE_BYTES = 4 * 1024 * 1024;

interface DockerContainer {
  Labels?: Record<string, string>;
  Config?: {
    Labels?: Record<string, string>;
    StopTimeout?: unknown;
    Tty?: boolean;
  };
}

interface DockerStats {
  cpu_stats?: {
    online_cpus?: number;
    cpu_usage?: {
      total_usage?: number;
      percpu_usage?: number[];
    };
    system_cpu_usage?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number; limit?: number };
  networks?: Record<string, Record<string, unknown>>;
  blkio_stats?: {
    io_service_bytes_recursive?: Array<{
      op?: string;
      value?: number;
    }>;
  };
}

export interface ContainerStats {
  cpuPercent: number;
  memoryUsed: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRx: number;
  networkTx: number;
  diskRead: number;
  diskWrite: number;
}

interface DockerClientOptions {
  socketPath?: string;
  enabled?: boolean;
}

interface DockerActionResult {
  success: boolean;
  error?: string;
  message?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isManagedContainer(
  container: unknown,
): container is DockerContainer {
  if (!container || typeof container !== "object") return false;
  const value = container as DockerContainer;
  const labels = value.Labels || value.Config?.Labels;
  return labels?.[MANAGED_LABEL] === "true";
}

export function demuxDockerLogStream(buffer: Buffer): string {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) break;
    parts.push(buffer.subarray(start, end));
    offset = end;
  }
  return Buffer.concat(parts).toString("utf-8");
}

function cpuCount(stats: DockerStats | null | undefined): number {
  return (
    stats?.cpu_stats?.online_cpus ||
    stats?.cpu_stats?.cpu_usage?.percpu_usage?.length ||
    1
  );
}

function sumEntries(
  entries: Array<{ op?: string; value?: number }> | undefined,
  operation: string,
): number {
  return (entries || [])
    .filter((entry) => entry.op?.toLowerCase() === operation)
    .reduce((sum, entry) => sum + (entry.value || 0), 0);
}

function sumNetwork(
  networks: Record<string, Record<string, unknown>> | undefined,
  field: string,
): number {
  return Object.values(networks || {}).reduce(
    (sum, network) => sum + (Number(network[field]) || 0),
    0,
  );
}

export function parseContainerStats(
  stats: DockerStats | null | undefined,
): ContainerStats {
  const cpuDelta =
    (stats?.cpu_stats?.cpu_usage?.total_usage || 0) -
    (stats?.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta =
    (stats?.cpu_stats?.system_cpu_usage || 0) -
    (stats?.precpu_stats?.system_cpu_usage || 0);
  const cores = cpuCount(stats);
  const memoryUsed = stats?.memory_stats?.usage || 0;
  const memoryLimit = stats?.memory_stats?.limit || 0;
  return {
    cpuPercent:
      systemDelta > 0 && cpuDelta > 0
        ? Math.round((cpuDelta / systemDelta) * cores * 1000) / 10
        : 0,
    memoryUsed,
    memoryLimit,
    memoryPercent:
      memoryLimit > 0 ? Math.round((memoryUsed / memoryLimit) * 1000) / 10 : 0,
    networkRx: sumNetwork(stats?.networks, "rx_bytes"),
    networkTx: sumNetwork(stats?.networks, "tx_bytes"),
    diskRead: sumEntries(
      stats?.blkio_stats?.io_service_bytes_recursive,
      "read",
    ),
    diskWrite: sumEntries(
      stats?.blkio_stats?.io_service_bytes_recursive,
      "write",
    ),
  };
}

export function lifecycleTimeoutMs(
  action: string,
  container: DockerContainer | null | undefined,
): number {
  if (action === "start") return LIFECYCLE_GRACE_MS;
  const configured = Number(container?.Config?.StopTimeout);
  const stopTimeoutSec =
    configured > 0 ? configured : DEFAULT_STOP_TIMEOUT_SEC;
  const grace =
    action === "restart" ? LIFECYCLE_GRACE_MS * 2 : LIFECYCLE_GRACE_MS;
  return stopTimeoutSec * 1000 + grace;
}

export class DockerClient {
  socketPath: string;
  enabled: boolean;
  lastError: string | null;

  constructor({
    socketPath = "/var/run/docker.sock",
    enabled = process.env.PANEL_DOCKER_CONTROL_ENABLED === "true",
  }: DockerClientOptions = {}) {
    this.socketPath = socketPath;
    this.enabled = enabled;
    this.lastError = null;
  }

  get available(): boolean {
    return this.enabled && fs.existsSync(this.socketPath);
  }

  async listManagedContainers(): Promise<unknown[]> {
    if (!this.available) return [];
    try {
      const containers = await this._requestJson(
        "GET",
        "/containers/json?all=true",
      );
      this.lastError = null;
      return Array.isArray(containers)
        ? containers.filter(isManagedContainer)
        : [];
    } catch (error: unknown) {
      this.lastError = errorMessage(error);
      log.warn(
        `Docker discovery failed: ${this.lastError}. The panel can see ${this.socketPath} but cannot query it — check that its user is in the socket's group.`,
      );
      return [];
    }
  }

  async inspectManagedContainer(
    containerId: string,
  ): Promise<DockerContainer | null> {
    if (!this.available) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerId)) return null;
    try {
      const container = await this._requestJson(
        "GET",
        `/containers/${encodeURIComponent(containerId)}/json`,
      );
      return isManagedContainer(container) ? container : null;
    } catch {
      return null;
    }
  }

  async runManagedAction(
    containerId: string,
    action: string,
  ): Promise<DockerActionResult> {
    if (!this.available) {
      return { success: false, error: "Docker control is unavailable" };
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerId)) {
      return { success: false, error: "Invalid container identifier" };
    }
    if (!["start", "stop", "restart"].includes(action)) {
      return { success: false, error: "Invalid container action" };
    }

    try {
      const container = await this.inspectManagedContainer(containerId);
      if (!container) {
        return {
          success: false,
          error: "Container is not managed by this panel",
        };
      }
      const statusCode = await this._requestStatus(
        "POST",
        `/containers/${encodeURIComponent(containerId)}/${action}`,
        lifecycleTimeoutMs(action, container),
      );
      if (statusCode === 304) {
        return {
          success: true,
          message: "Container is already in the requested state",
        };
      }
      if (statusCode >= 200 && statusCode < 300) return { success: true };
      return { success: false, error: `Docker API returned ${statusCode}` };
    } catch (error: unknown) {
      const message = errorMessage(error);
      log.warn(`Docker ${action} failed for ${containerId}: ${message}`);
      return { success: false, error: message || "Docker action failed" };
    }
  }

  async getContainerStats(containerId: string): Promise<ContainerStats | null> {
    if (!this.available) return null;
    try {
      const raw = await this._requestJson(
        "GET",
        `/containers/${encodeURIComponent(containerId)}/stats?stream=false`,
      );
      return parseContainerStats(raw as DockerStats);
    } catch (error: unknown) {
      log.debug(`Docker stats failed for ${containerId}: ${errorMessage(error)}`);
      return null;
    }
  }

  async getContainerLogs(
    containerId: string,
    { tail = DEFAULT_LOG_TAIL_LINES }: { tail?: number } = {},
  ): Promise<string | null> {
    if (!this.available) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerId)) return null;
    const tailCount =
      Number.isInteger(tail) && tail > 0 ? tail : DEFAULT_LOG_TAIL_LINES;
    try {
      const container = await this.inspectManagedContainer(containerId);
      if (!container) return null;
      const raw = await this._requestBuffer(
        "GET",
        `/containers/${encodeURIComponent(containerId)}/logs?stdout=true&stderr=true&timestamps=true&tail=${tailCount}`,
      );
      return container.Config?.Tty === true
        ? raw.toString("utf-8")
        : demuxDockerLogStream(raw);
    } catch (error: unknown) {
      log.debug(
        `Docker logs fetch failed for ${containerId}: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private _requestJson(
    method: string,
    requestPath: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: requestPath,
          timeout: timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            if ((response.statusCode ?? 0) >= 400) {
              reject(new Error(`Docker API returned ${response.statusCode}`));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
            } catch {
              reject(new Error("Docker API returned invalid JSON"));
            }
          });
        },
      );
      request.on("timeout", () =>
        request.destroy(new Error("Docker API timed out")),
      );
      request.on("error", reject);
      request.end();
    });
  }

  private _requestBuffer(
    method: string,
    requestPath: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
    maxBytes = MAX_LOG_RESPONSE_BYTES,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const request = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: requestPath,
          timeout: timeoutMs,
        },
        (response) => {
          if ((response.statusCode ?? 0) >= 400) {
            response.resume();
            settled = true;
            reject(new Error(`Docker API returned ${response.statusCode}`));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer) => {
            if (settled) return;
            total += chunk.length;
            if (total > maxBytes) {
              settled = true;
              request.destroy();
              reject(new Error(`Docker API response exceeded ${maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks));
          });
        },
      );
      request.on("timeout", () => {
        if (settled) return;
        settled = true;
        const timeoutError = new Error("Docker API timed out");
        request.destroy(timeoutError);
        reject(timeoutError);
      });
      request.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      request.end();
    });
  }

  private _requestStatus(
    method: string,
    requestPath: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: requestPath,
          timeout: timeoutMs,
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.on("timeout", () =>
        request.destroy(new Error("Docker API timed out")),
      );
      request.on("error", reject);
      request.end();
    });
  }
}
