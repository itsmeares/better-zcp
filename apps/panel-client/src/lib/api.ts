import { apiUrl, getSelectedServerId } from "./serverSelection";
import { reportClientWarning } from "./client-errors";
import { ApiError } from "./ApiError";
export { ApiError } from "./ApiError";
import { clearAccessToken, getAccessToken, setAccessToken } from "./authToken";
import { toast } from "@/components/ui/use-toast";
import type { LifecycleState } from "./serverStatus";


function getAuthToken(): string | null {
  return getAccessToken();
}

function withAuth(options?: RequestInit): RequestInit {
  const token = getAuthToken();
  if (!token) return options || {};

  const headers = new Headers(options?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...options, headers };
}

let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

export async function tryRefreshToken(): Promise<boolean> {
  if (isRefreshing && refreshPromise) return refreshPromise;

  isRefreshing = true;
  refreshPromise = (async () => {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setAccessToken(data.accessToken);
        return true;
      }
      clearAccessToken();
      return false;
    } catch {
      clearAccessToken();
      return false;
    } finally {
      isRefreshing = false;
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 5000,
  fetchTimeout: 15000, // 15 second timeout for fetch requests
};

const RETRY_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function requestMethod(options?: RequestInit): string {
  return String(options?.method || "GET").toUpperCase();
}

function getRetryDelay(attempt: number): number {
  const delay = Math.min(
    RETRY_CONFIG.baseDelay * Math.pow(2, attempt),
    RETRY_CONFIG.maxDelay,
  );
  return delay * (0.75 + Math.random() * 0.5);
}

function isRetryableError(error: unknown, response?: Response): boolean {
  if (error instanceof ApiError) {
    return error.isRetryable;
  }
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (response && response.status >= 500) {
    return true;
  }
  if (response?.status === 429) {
    return true;
  }
  return false;
}

function getStatusMessage(status: number): string {
  switch (status) {
    case 400:
      return "The request was invalid. Check the provided values and try again.";
    case 401:
      return "Your session has expired. Sign in again and retry.";
    case 403:
      return "You do not have permission to perform this action.";
    case 404:
      return "The requested resource was not found.";
    case 408:
      return "The request timed out. Try again.";
    case 409:
      return "The request could not be completed because the data changed.";
    case 413:
      return "The submitted content is too large.";
    case 422:
      return "The server rejected the submitted values. Review the form and try again.";
    case 429:
      return "Too many requests were sent. Wait a moment and try again.";
    case 500:
    case 502:
    case 503:
    case 504:
      return "The server is temporarily unavailable. Try again shortly.";
    default:
      return `Request failed with status ${status}.`;
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return new ApiError(
      "The request timed out. Check your connection and try again.",
      {
        code: "TIMEOUT",
        isRetryable: true,
        isTimeout: true,
        isNetworkError: true,
      },
    );
  }

  if (error instanceof TypeError) {
    return new ApiError(
      "Unable to reach the server. Check your network connection and try again.",
      {
        code: "NETWORK_ERROR",
        isRetryable: true,
        isNetworkError: true,
      },
    );
  }

  if (error instanceof Error) {
    const serverError = error as Error & {
      status?: unknown;
      code?: unknown;
      params?: unknown;
      data?: unknown;
    };
    return new ApiError(error.message, {
      status:
        typeof serverError.status === "number" ? serverError.status : undefined,
      code: typeof serverError.code === "string" ? serverError.code : undefined,
      data:
        serverError.data !== undefined
          ? serverError.data
          : serverError.params !== undefined
            ? { params: serverError.params }
            : undefined,
    });
  }

  return new ApiError(
    "An unexpected error occurred while contacting the server.",
  );
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  try {
    const text = await response.text();
    return text || null;
  } catch {
    return null;
  }
}

function buildResponseError(response: Response, payload?: unknown): ApiError {
  const messageFromPayload =
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
      ? payload.error
      : payload &&
          typeof payload === "object" &&
          "message" in payload &&
          typeof payload.message === "string"
        ? payload.message
        : typeof payload === "string" && payload.trim()
          ? payload.trim()
          : getStatusMessage(response.status);

  const codeFromPayload =
    payload &&
    typeof payload === "object" &&
    "code" in payload &&
    typeof (payload as { code: unknown }).code === "string"
      ? (payload as { code: string }).code
      : `HTTP_${response.status}`;

  return new ApiError(messageFromPayload, {
    status: response.status,
    code: codeFromPayload,
    isRetryable:
      response.status >= 500 ||
      response.status === 429 ||
      response.status === 408,
    data: payload,
  });
}

async function responseHasCode(
  response: Response,
  expectedCode: string,
): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const payload = await response.clone().json();
    return (
      payload !== null &&
      typeof payload === "object" &&
      "code" in payload &&
      payload.code === expectedCode
    );
  } catch {
    return false;
  }
}

async function fetchWithRetry(
  url: string,
  options?: RequestInit & { timeout?: number },
  retries: number = RETRY_CONFIG.maxRetries,
): Promise<Response> {
  let lastError: unknown;
  const effectiveTimeout = options?.timeout || RETRY_CONFIG.fetchTimeout;
  const method = requestMethod(options);
  const transportRetries = RETRY_SAFE_METHODS.has(method) ? retries : 0;
  let authenticationReplayUsed = false;

  for (let attempt = 0; attempt <= transportRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

      const externalSignal = options?.signal;
      if (externalSignal) {
        if (externalSignal.aborted) {
          controller.abort(externalSignal.reason);
        } else {
          externalSignal.addEventListener(
            "abort",
            () => controller.abort(externalSignal.reason),
            { once: true },
          );
        }
      }

      try {
        const response = await fetch(url, {
          ...withAuth(options),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (
          response.status === 401 &&
          !authenticationReplayUsed &&
          !url.includes("/api/auth/") &&
          (await responseHasCode(response, "TOKEN_EXPIRED"))
        ) {
          authenticationReplayUsed = true;
          const refreshed = await tryRefreshToken();
          if (refreshed) {
            const retryController = new AbortController();
            const retryTimeoutId = setTimeout(
              () => retryController.abort(),
              effectiveTimeout,
            );
            const retryResponse = await fetch(url, {
              ...withAuth(options),
              signal: retryController.signal,
            }).finally(() => clearTimeout(retryTimeoutId));
            if (retryResponse.status === 401) {
              clearAccessToken();
              window.location.reload();
            }
            return retryResponse;
          } else {
            window.location.reload();
            return response;
          }
        }

        if (
          !isRetryableError(null, response) ||
          attempt === transportRetries
        ) {
          return response;
        }
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, getRetryDelay(attempt)),
      );
    } catch (error) {
      lastError = toApiError(error);

      if (
        attempt === transportRetries ||
        !isRetryableError(lastError)
      ) {
        throw lastError;
      }

      reportClientWarning(
        `Request failed, retrying (${attempt + 1}/${transportRetries})...`,
        lastError,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, getRetryDelay(attempt)),
      );
    }
  }

  throw toApiError(lastError);
}

export function apiFetch(endpoint: string, options?: RequestInit,
  retries?: number,
) {
  return fetchWithRetry(apiUrl(endpoint), options, retries);
}

async function handleResponse<T = any>(response: Response): Promise<T> {
  const data = await parseResponseBody(response);
  if (!response.ok) {
    throw buildResponseError(response, data);
  }
  if (data === null || typeof data !== "object") {
    throw new ApiError("The server returned an invalid response.", {
      status: response.status,
      code: "INVALID_RESPONSE",
    });
  }
  if ((data as { success?: unknown }).success === false) {
    throw buildResponseError(response, data);
  }
  showBackupWarning(data);
  return data as T;
}

function showBackupWarning(data: unknown): void {
  const backupWarning =
    data && typeof data === "object"
      ? (data as { backupWarning?: unknown }).backupWarning
      : undefined;
  if (typeof backupWarning !== "string" || !backupWarning) return;
  toast({
    variant: "warning",
    title: "Backup warning",
    description: backupWarning,
  });
}

function apiGet<T = any>(
  endpoint: string,
  options?: RequestInit & { timeout?: number },
  retries?: number,
): Promise<T> {
  return fetchWithRetry(apiUrl(endpoint), options, retries).then((response) =>
    handleResponse<T>(response),
  );
}

function apiPost<T = any>(
  endpoint: string,
  body?: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  return fetchWithRetry(apiUrl(endpoint), {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: options?.signal,
  }).then((response) => handleResponse<T>(response));
}

function apiPut<T = any>(endpoint: string, body?: unknown): Promise<T> {
  return fetchWithRetry(apiUrl(endpoint), {
    method: "PUT",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then((response) => handleResponse<T>(response));
}

function apiRoute<T = any>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  data?: object,
): Promise<T> {
  const values: Record<string, unknown> = { ...data };
  let endpoint = path.replace(/:([a-zA-Z]\w*)/g, (_match, key: string) => {
    const value = values[key];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`Missing URL parameter: ${key}`);
    }
    delete values[key];
    return encodeURIComponent(String(value));
  });
  const target = (data as {serverId?: unknown; expectedServerId?: unknown})?.expectedServerId
    ?? (method === "PUT" && path.startsWith("/scheduler/tasks/") ? undefined : (data as {serverId?: unknown})?.serverId);
  if (typeof target === "string" || typeof target === "number") endpoint = apiUrl(endpoint, String(target)).slice(4);
  if (method === "GET") {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    return apiGet(endpoint + (query.size ? `?${query}` : ""));
  }
  if (method === "POST") return apiPost(endpoint, data === undefined ? undefined : values);
  if (method === "PUT") return apiPut(endpoint, data === undefined ? undefined : values);
  return fetchWithRetry(apiUrl(endpoint), {
    method: "DELETE",
    headers: Object.keys(values).length ? { "Content-Type": "application/json" } : undefined,
    body: Object.keys(values).length ? JSON.stringify(values) : undefined,
  }).then((response) => handleResponse<T>(response));
}

export interface SteamBranch {
  name: string;
  description: string;
  buildId?: string | null;
  timeUpdated?: string | null;
}

export const serverApi = {
  getStatus: (_options?: { retries?: number }) =>
    apiRoute("GET", "/server/status"),
  getNetworkInterfaces: (): Promise<{
    interfaces: { name: string; address: string }[];
  }> => apiRoute("GET", "/server/network-interfaces"),
  start: (serverId = getSelectedServerId()) => apiPost(apiUrl("/server/start", serverId).slice(4)),
  stop: (serverId = getSelectedServerId()) => apiPost(apiUrl("/server/stop", serverId).slice(4)),
  forceStop: () => apiRoute("POST", "/server/force-stop"),
  restart: (warningMinutes?: number) =>
    apiRoute("POST", "/server/restart", { warningMinutes }),
  restartNow: () =>
    apiRoute("POST", "/server/restart", { warningMinutes: 0 }),
  save: () => apiRoute("POST", "/server/save"),
  sendMessage: (message: string) =>
    apiRoute("POST", "/server/message", { message }),

  wipePreview: (targets: string[]) =>
    apiPost("/server/wipe/preview", { targets }),
  wipe: (targets: string[], createBackup: boolean = true) =>
    apiPost("/server/wipe", { targets, confirm: true, createBackup }) as Promise<{
      success: boolean;
      backupCreated: boolean;
      backupName: string | null;
    }>,

  getPanelInfo: () =>
    apiGet("/panel-info") as Promise<{
      localIp: string;
      port: number;
      url: string;
    }>,

  restartPanel: () => apiPost("/panel/restart"),

  getBranches: (steamcmdPath?: string) =>
    apiGet(
      `/server/branches${steamcmdPath ? `?steamcmdPath=${encodeURIComponent(steamcmdPath)}` : ""}`,
    ) as Promise<{ branches: SteamBranch[]; source: string; message: string }>,

  install: (config: Record<string, unknown>) =>
    apiPost("/server/install", config),

  detectSteamCmd: () =>
    apiGet("/server/steamcmd/detect") as Promise<{
      found: boolean;
      path?: string;
      executable?: string;
      message: string;
    }>,

  quickSetup: (config: Record<string, unknown>) =>
    apiPost("/server/quick-setup", config),

  configureRcon: (config: { rconPassword: string; rconPort?: number }) =>
    apiPost("/server/configure-rcon", config),

  configureNetwork: (config: { serverPort?: number; useUpnp?: boolean }) =>
    apiPost("/server/configure-network", config),

  downloadSteamCmd: (installPath?: string) =>
    apiPost("/server/steamcmd/download", { installPath }),
  checkSteamCmd: (path: string) =>
    apiGet(`/server/steamcmd/check?path=${encodeURIComponent(path)}`),

  listDirectory: (dirPath?: string) =>
    apiPost("/server/list-directory", { dirPath }) as Promise<{
      entries: Array<{
        name: string;
        path: string;
        label?: string;
        isDrive?: boolean;
      }>;
      currentPath: string | null;
      parentPath: string | null;
    }>,

  reloadLua: (filename: string) =>
    apiRoute("POST", "/server/reloadlua", { filename }),

  setLogLevel: (type: string, level: string) =>
    apiRoute("POST", "/server/log", { type, level }),

  setStats: (mode: string, period?: number) =>
    apiRoute("POST", "/server/stats", { mode, period }),

  getConsoleLog: (lines?: number) =>
    apiGet(`/server/console-log${lines ? `?lines=${lines}` : ""}`),
  streamConsoleLog: (lastSize: number) =>
    apiGet(`/server/console-log/stream?lastSize=${lastSize}`),
  getConsoleErrorCount: (): Promise<{
    exists: boolean
    count: number
    sinceStart: boolean
    truncated?: boolean
  }> => apiGet("/server/console-log/error-count"),
  clearConsoleLog: () => apiPost("/server/console-log/clear"),
};

export const playersApi = {
  getPlayers: (_options?: { retries?: number }) =>
    apiRoute("GET", "/players"),
  getWhitelist: (): Promise<{
    success: boolean
    available: boolean
    accounts: Array<{
      id: number
      username: string
      lastConnection: string | null
      role: string
      authType: number
      steamId: string | null
      ownerId: string | null
      displayName: string | null
    }>
    allowedSteamIds: string[]
    reason?: string
    server?: { id: string | number; name: string }
  }> => apiRoute("GET", "/players/whitelist"),
  kick: (username: string, reason?: string) =>
    apiRoute("POST", "/players/kick", { username, reason }),
  ban: (username: string, banIp?: boolean, reason?: string) =>
    apiRoute("POST", "/players/ban", { username, banIp, reason }),
  unban: (username: string) =>
    apiRoute("POST", "/players/unban", { username }),
  setAccessLevel: (username: string, level: string) =>
    apiRoute("POST", "/players/access-level", { username, level }),
  addToWhitelist: (username: string, password: string) =>
    apiRoute("POST", "/players/whitelist/add", { username, password }),
  removeFromWhitelist: (username: string) =>
    apiRoute("POST", "/players/whitelist/remove", { username }),
  addAllowedSteamId: (steamId: string) =>
    apiRoute("POST", "/players/whitelist/steamid/add", { steamId }),
  removeAllowedSteamId: (steamId: string) =>
    apiRoute("POST", "/players/whitelist/steamid/remove", { steamId }),
  teleport: (
    player1: string,
    destination?: string | { x: number; y: number; z?: number },
  ) => {
    if (destination && typeof destination === "object") {
      return apiRoute("POST", "/players/teleport", {
            player1,
            x: destination.x,
            y: destination.y,
            z: destination.z ?? 0,
          });
    }

    return apiRoute("POST", "/players/teleport", { player1, player2: destination });
  },
  addItem: (username: string | null, item: string, count?: number) =>
    apiRoute("POST", "/players/add-item", { username, item, count }),
  addXp: (username: string, perk: string, amount: number) =>
    apiRoute("POST", "/players/add-xp", { username, perk, amount }),
  setGodMode: (username: string | null, enabled: boolean) =>
    apiRoute("POST", "/players/godmode", { username, enabled }),
  setInvisible: (username: string | null, enabled: boolean) =>
    apiRoute("POST", "/players/invisible", { username, enabled }),
  setNoclip: (username: string | null, enabled: boolean) =>
    apiRoute("POST", "/players/noclip", { username, enabled }),
  getPerks: () => apiRoute("GET", "/players/perks"),
  getAccessLevels: () => apiRoute("GET", "/players/access-levels"),
  banSteamId: (steamId: string, reason?: string) =>
    apiRoute("POST", "/players/banid", { steamId, reason }),
  unbanSteamId: (steamId: string) =>
    apiRoute("POST", "/players/unbanid", { steamId }),
  getSteamIdBans: () => apiRoute("GET", "/players/steamid-bans"),
  voiceBan: (username: string, enabled: boolean) =>
    apiRoute("POST", "/players/voiceban", { username, enabled }),
  addUser: (username: string, password: string) =>
    apiRoute("POST", "/players/adduser", { username, password }),
  addAllToWhitelist: () => apiRoute("POST", "/players/whitelist/addall"),
  getActivityLogs: (player?: string, limit?: number) =>
    apiRoute("GET", "/players/activity", { player, limit: limit || 100 }),
  getStats: () => apiRoute("GET", "/players/stats"),
  getStat: (playerName: string) => apiRoute("GET", "/players/stats/:playerName", { playerName }),
};

export interface RconTestResult {
  success: boolean;
  error?: "unreachable" | "auth_failed" | "invalid_input" | "internal_error";
  detail: string;
}

export const rconApi = {
  execute: (command: string) =>
    apiRoute("POST", "/rcon/execute", { command }),
  getStatus: () => apiRoute("GET", "/rcon/status"),
  connect: (host?: string, port?: number, password?: string) =>
    apiRoute("POST", "/rcon/connect", { host, port, password }),
  disconnect: () => apiRoute("POST", "/rcon/disconnect"),
  getHistory: (limit?: number) =>
    apiRoute("GET", "/rcon/history", { limit }),
  getCommands: () => apiRoute("GET", "/rcon/commands"),
  testConnection: (host: string, port: number, password: string) =>
    apiRoute("POST", "/rcon/test", { host, port, password }),
};

export interface ScheduleHistoryEntry {
  id: number;
  task_id: number | null;
  task_name: string;
  command: string;
  success: number;
  message: string | null;
  duration: number | null;
  executed_at: string;
}

export interface RestartWarningSettings {
  locale: "en" | "zh-CN" | "fr" | "de" | "es" | "ht";
  template: string;
}

export interface SchedulerStatus {
  maintenance: { kind: string; label: string; phase: string; startedAt: string } | null;
  activeTasks: number;
  autoRestartEnabled: boolean;
  timezone?: string;
  configuredTimezone?: string | null;
  timezoneFallback?: { configured: string; effective: string } | null;
  restartWarning?: RestartWarningSettings;
  restartWarningPresets?: Record<RestartWarningSettings["locale"], string>;
}

export const schedulerApi = {
  cancelMaintenance: () => apiPost("/scheduler/maintenance/cancel"),
  getStatus: () =>
    apiRoute("GET", "/scheduler/status") as Promise<SchedulerStatus>,
  getTasks: () => apiRoute("GET", "/scheduler/tasks"),
  createTask: (
    name: string,
    cronExpression: string,
    command: string,
    serverId?: string | number,
  ) =>
    apiPost(serverId == null ? "/scheduler/tasks" : `/servers/${encodeURIComponent(String(serverId))}/scheduler/tasks`, { name, cronExpression, command, serverId }),
  updateTask: (
    id: number,
    name: string,
    cronExpression: string,
    command: string,
    enabled: boolean,
    serverId?: string | number,
  ) =>
    apiRoute("PUT", "/scheduler/tasks/:id", { id, name, cronExpression, command, enabled, serverId }),
  deleteTask: (id: number) =>
    apiRoute("DELETE", "/scheduler/tasks/:id", { id }),
  runTask: (id: number) => apiRoute("POST", "/scheduler/tasks/:id/run", { id }),
  restartNow: (warningMinutes?: number) =>
    apiRoute("POST", "/scheduler/restart-now", { warningMinutes }) as Promise<{
      success: boolean;
      message: string;
      warningMinutes: number;
    }>,
  getCronPresets: () => apiRoute("GET", "/scheduler/cron-presets"),
  validateCron: (cronExpression: string) =>
    apiRoute("POST", "/scheduler/validate-cron", { cronExpression }) as Promise<{
      valid: boolean;
      error?: string;
      code?: string;
    }>,
  getHistory: (limit?: number, taskId?: number) => {
    return apiRoute("GET", "/scheduler/history", { limit, taskId }) as Promise<{
      history: ScheduleHistoryEntry[];
    }>;
  },
  clearHistory: () => apiRoute("DELETE", "/scheduler/history"),
  setTimezone: (timezone: string) =>
    apiRoute("PUT", "/scheduler/timezone", { timezone }) as Promise<{
      success: boolean;
      timezone: string;
      configuredTimezone: string | null;
      timezoneFallback: { configured: string; effective: string } | null;
    }>,
  setRestartWarning: (restartWarning: RestartWarningSettings) =>
    apiRoute("PUT", "/scheduler/restart-warning", restartWarning) as Promise<{
      success: boolean;
      restartWarning: RestartWarningSettings;
    }>,
};

export const modsApi = {
  getStatus: (_options?: RequestInit) =>
    apiRoute("GET", "/mods/status"),
  getTrackedMods: (_options?: RequestInit) =>
    apiRoute("GET", "/mods/tracked"),
  trackMod: (workshopId: string) =>
    apiRoute("POST", "/mods/track", { workshopId }),
  untrackMod: (workshopId: string) =>
    apiRoute("DELETE", "/mods/track/:workshopId", { workshopId }),

  getIgnoredMods: () => apiRoute("GET", "/mods/ignored"),
  unignoreMod: (workshopId: string) =>
    apiRoute("DELETE", "/mods/ignored/:workshopId", { workshopId }),
  clearAllIgnoredMods: () =>
    apiRoute("DELETE", "/mods/ignored"),

  getIgnoredModPairs: () =>
    apiRoute("GET", "/mods/ignored-pairs") as Promise<
      Array<{
        mod_a: string;
        mod_b: string;
        reason?: string | null;
        server_id?: string | null;
        ignored_at: string;
      }>
    >,
  addIgnoredModPair: (modIdA: string, modIdB: string, reason?: string) =>
    apiRoute("POST", "/mods/ignored-pairs", { modIdA, modIdB, reason }),
  removeIgnoredModPair: (modIdA: string, modIdB: string) =>
    apiRoute("DELETE", "/mods/ignored-pairs", { modIdA, modIdB }),
  checkUpdates: (options?: { signal?: AbortSignal }) =>
    apiPost("/mods/check-updates", undefined, options),
  getServerMods: () => apiRoute("GET", "/mods/server-mods"),
  syncFromServer: (options?: { signal?: AbortSignal }) =>
    apiPost("/mods/sync-from-server", undefined, options),
  clearUpdates: (options?: { signal?: AbortSignal }) =>
    apiPost("/mods/clear-updates", undefined, options),
  start: (_options?: { signal?: AbortSignal }) =>
    apiRoute("POST", "/mods/start"),
  stop: (_options?: { signal?: AbortSignal }) =>
    apiRoute("POST", "/mods/stop"),
  setAutoRestart: (enabled: boolean) =>
    apiRoute("POST", "/mods/auto-restart", { enabled }),
  setRestartOptions: (options: {
    warningMinutes?: number;
    forceAfterDeadline?: boolean;
    maxDelayMinutes?: number;
    checkInterval?: number;
  }) =>
    apiRoute("PUT", "/mods/restart-options", options),
  cancelPendingRestart: () =>
    apiRoute("POST", "/mods/cancel-pending-restart"),
  getWorkshopStatus: () => apiRoute("GET", "/mods/workshop-status"),

  importCollection: (collectionUrl: string) =>
    apiPost("/mods/import-collection", { collectionUrl }),

  getModInfo: (workshopId: string) =>
    apiPost("/mods/get-mod-info", { workshopId }),

  writeToIni: (
    mods: Array<{ workshopId: string; modId: string }>,
    mapFolders?: string[],
  ) => apiPost("/mods/write-to-ini", { mods, mapFolders }),

  getCurrentConfig: () => apiGet("/mods/current-config"),

  addToIni: (workshopId: string, modId?: string) =>
    apiPost("/mods/add-to-ini", { workshopId, modId }),

  removeFromIni: (workshopId: string, modId?: string, modIds?: string[]) =>
    apiPost("/mods/remove-from-ini", { workshopId, modId, modIds }),

  batchRemove: (workshopIds: string[]) =>
    apiPost("/mods/batch-remove", { workshopIds }),

  refreshNames: (workshopIds?: string[]) =>
    apiPost("/mods/refresh-names", { workshopIds }) as Promise<{
      success: boolean;
      checked: number;
      diskResolved: number;
      steamResolved: number;
      totalResolved: number;
      unresolved: number;
    }>,

  listDiskOnly: () =>
    apiGet("/mods/disk-only") as Promise<{
      mods: Array<{ workshop_id: string; name: string }>;
      reason?: string;
    }>,

  enableDiskMod: (workshopId: string) =>
    apiPost("/mods/enable-disk-mod", { workshopId }) as Promise<{
      success: boolean;
      workshopId: string;
      modIdsAdded: number;
    }>,

  deleteDiskMod: (workshopId: string) =>
    apiPost("/mods/delete-disk-mod", { workshopId }) as Promise<{
      success: boolean;
      workshopId: string;
      deletedFromDisk: boolean;
      modIdsStripped: number;
    }>,

  batchDeleteDiskMods: (workshopIds: string[]) =>
    apiPost("/mods/batch-delete-disk-mods", { workshopIds }) as Promise<{
      success: boolean;
      total: number;
      deletedFromDisk: number;
      modIdsStripped: number;
      results: Array<{ workshopId: string; deletedFromDisk: boolean }>;
    }>,

  resolveOrphanWorkshop: (workshopIds: string[]) =>
    apiPost("/mods/resolve-orphan-workshop", { workshopIds }) as Promise<{
      success: boolean;
      total: number;
      counts: {
        enabled: number;
        droppedIgnored: number;
        droppedMissing: number;
        droppedNoModInfo: number;
      };
      modIdsAdded: number;
      wsDropped: number;
      breakdown: Array<{
        workshopId: string;
        action: string;
        modIds: string[];
      }>;
    }>,

  toggleModId: (modId: string, enabled: boolean) =>
    apiPost("/mods/toggle-mod-id", { modId, enabled }) as Promise<{
      success: boolean;
      modId: string;
      enabled: boolean;
      totalMods: number;
    }>,

  batchToggleModIds: (changes: Array<{ modId: string; enabled: boolean }>) =>
    apiPost("/mods/batch-toggle-mod-ids", { changes }) as Promise<{
      success: boolean;
      changed: number;
      totalMods: number;
    }>,

  repairMapEntries: () =>
    apiPost("/mods/repair-map-entries") as Promise<{
      success: boolean;
      removed: string[];
      added?: string[];
      remaining: string[];
      message: string;
    }>,

  deduplicateModIds: () =>
    apiPost("/mods/deduplicate-mod-ids") as Promise<{
      success: boolean;
      removed: string[];
      removedCount: number;
      remaining: number;
      message: string;
    }>,

  addMissingDep: (workshopId: string, modId?: string) =>
    apiPost("/mods/add-missing-dep", { workshopId, modId }) as Promise<{
      success: boolean;
      workshopId: string;
      modId: string | null;
      wsAdded: boolean;
      modIdAdded: boolean;
      mapFolders: string[];
      message: string;
    }>,

  addAllResolvedDeps: (deps: Array<{ workshopId: string; modId?: string }>) =>
    apiPost("/mods/add-all-resolved-deps", { deps }) as Promise<{
      success: boolean;
      total: number;
      wsAdded: number;
      modIdsAdded: number;
      mapFolders: string[];
      results: Array<{
        workshopId: string;
        modId: string | null;
        wsAdded: boolean;
        modIdAdded: boolean;
      }>;
      message: string;
    }>,

  searchWorkshopMods: (
    query: string,
    opts?: {
      parentName?: string;
      parentWorkshopId?: string;
      parentModId?: string;
    },
  ) =>
    apiPost("/mods/search-workshop-mods", {
      query,
      ...(opts || {}),
    }) as Promise<{
      success: boolean;
      query: string;
      variantsTried?: string[];
      steamSearchEnabled?: boolean;
      steamSearchAttempted?: boolean;
      results: Array<{
        workshopId: string;
        modId?: string;
        modName: string;
        description?: string;
        subscriberCount?: number;
        source: "local" | "steam";
        isDownloaded: boolean;
        matchedVariant?: string;
        relevance?: number;
      }>;
      searchUrl: string;
    }>,

  resolveMissingDeps: (
    deps: Array<{ missingDep: string; resolvedWorkshopId?: string }>,
  ) =>
    apiPost("/mods/resolve-missing-deps", { deps }) as Promise<{
      success: boolean;
      deps: Array<{
        missingDep: string;
        resolvedWorkshopId?: string;
        resolvedModName?: string;
      }>;
      resolvedCount: number;
    }>,

  collectionDiff: () =>
    apiGet("/mods/collection/diff") as Promise<{
      ok: boolean;
      error?: string;
      title?: string | null;
      inCollection: string[];
      toAdd: string[];
      toRemove: string[];
      collectionOnly?: string[];
      items: Array<{
        workshopId: string;
        name: string | null;
        status: "synced" | "to-add" | "collection-only" | "tracked-only";
        inTracked: boolean;
        inCollection: boolean;
        inServer: boolean;
      }>;
      collectionId: string | null;
      trackedCount: number;
      serverConfigRead?: boolean;
    }>,
  collectionUntrack: (workshopId: string) =>
    apiRoute("DELETE", "/mods/collection/tracking/:workshopId", { workshopId }) as Promise<{
      ok: true;
      workshopId: string;
      removed: boolean;
      message: string;
    }>,
  purgeMod: (workshopId: string, name?: string | null) =>
    apiPost("/mods/purge", { workshopId, name }) as Promise<{
      success: boolean;
      workshopId: string;
      name: string | null;
      deletedFromDisk: boolean;
      modIdsStripped: number;
      mapFoldersStripped: number;
    }>,
  syncModIds: () => apiPost("/mods/sync-mod-ids"),

  discoverModIds: (
    workshopId?: string,
    workshopUrl?: string,
    options?: { signal?: AbortSignal },
  ) =>
    apiPost(
      "/mods/discover-mod-ids",
      { workshopId, workshopUrl },
      options,
    ) as Promise<{
      success: boolean;
      workshopId: string;
      name: string;
      description: string | null;
      modIds: string[];
      hasMultipleModIds: boolean;
      sources: Array<{ modId: string; source: string }>;
      isMap: boolean;
      mapFolders: string[];
      isDownloaded: boolean;
      tags: string[];
    }>,

  addModAdvanced: (
    workshopId: string,
    selectedModIds?: string[],
    includeAllModIds?: boolean,
    displayName?: string,
    mapFolder?: string,
  ) =>
    apiPost("/mods/add-mod-advanced", {
      workshopId,
      selectedModIds,
      includeAllModIds,
      displayName,
      mapFolder,
    }) as Promise<{
      success: boolean;
      workshopId: string;
      addedModIds: string[];
      totalModIdsInConfig: number;
      workshopAlreadyExisted: boolean;
      mapFoldersAdded: string[];
      message: string;
    }>,

  saveModOrder: (modIds: string[]) => apiPost("/mods/save-order", { modIds }),

  getConflicts: (options?: RequestInit) =>
    apiGet<import("@/types").ConflictScanResult>("/mods/conflicts", options),
  getCachedConflicts: () =>
    apiGet<
      | (import("@/types").ConflictScanResult & {
          stale?: boolean;
          _workshopIdsSnapshot?: string[];
          _modIdsSnapshot?: string[];
        })
      | null
    >("/mods/conflicts/cached"),
};

export const configApi = {
  getAppSettings: (): Promise<{ settings: Record<string, any> }> =>
    apiRoute("GET", "/config/app-settings"),
  updateAppSettings: (settings: Record<string, unknown>) =>
    apiRoute("PUT", "/config/app-settings", { settings }),
  getCorsDiagnostics: () =>
    apiRoute("GET", "/config/cors-debug") as Promise<{
      diagnostics: {
        allowAll: boolean;
        allowPrivateNetworks: boolean;
        debug: boolean;
        customOrigins: string[];
        effectiveAllowedOrigins: string[];
        blocked: Array<{
          id: number;
          origin: string;
          source: string;
          blockedAt: string;
        }>;
        blockedCount: number;
        lastLoadedAt: string | null;
      };
    }>,
  reloadCorsDiagnostics: () =>
    apiRoute("POST", "/config/cors-debug/reload") as Promise<{
      success: boolean;
      diagnostics: {
        allowAll: boolean;
        allowPrivateNetworks: boolean;
        debug: boolean;
        customOrigins: string[];
        effectiveAllowedOrigins: string[];
        blocked: Array<{
          id: number;
          origin: string;
          source: string;
          blockedAt: string;
        }>;
        blockedCount: number;
        lastLoadedAt: string | null;
      };
    }>,
  clearCorsBlockedOrigins: () =>
    apiRoute("DELETE", "/config/cors-debug/blocked") as Promise<{
      success: boolean;
      diagnostics: {
        allowAll: boolean;
        allowPrivateNetworks: boolean;
        debug: boolean;
        customOrigins: string[];
        effectiveAllowedOrigins: string[];
        blocked: Array<{
          id: number;
          origin: string;
          source: string;
          blockedAt: string;
        }>;
        blockedCount: number;
        lastLoadedAt: string | null;
      };
    }>,
  testRcon: () =>
    apiRoute("POST", "/config/test-rcon"),
};

export interface ConfigTestRconResult {
  success: boolean;
  connected: boolean;
  message?: string;
  warning?: boolean;
  error?: "unreachable" | "auth_failed";
  detail?: string;
}

export interface ServerInstance {
  id: string | number;
  name: string;
  serverName: string;
  installPath: string;
  zomboidDataPath: string | null;
  serverConfigPath: string | null;
  dockerContainerName?: string | null;
  dockerContainerId?: string | null;
  branch?: string;
  rconHost: string;
  rconPort: number;
  rconPassword: string;
  serverPort: number;
  minMemory: number;
  maxMemory: number;
  useNoSteam: boolean;
  useDebug: boolean;
  useUpnp?: boolean;
  isActive: boolean;
  startCommand: string;
  lifecycleProvider?: "direct" | "systemd" | "openrc";
  adminPassword: string;
  createdAt: string;
}

export interface DiscoveredMount {
  installPath: string;
  dataPath: string | null;
  source: string;
  serverNames: string[];
  hasStartScript: boolean;
  hasGameIntegration: boolean;
}

export interface ServerStatusSignal {
  status: string;
  label: string;
  detail: string | null;
}

export interface ComposedServerStatus {
  provider: string;
  selected: boolean;
  state?: LifecycleState;
  host: ServerStatusSignal;
  server: ServerStatusSignal;
  gameIntegration: ServerStatusSignal;
  summary: string;
}

export const serversApi = {
  getAll: () => {
    const selectedId = getSelectedServerId();
    return apiGet("/servers").then(data => ({ ...data, servers: data.servers.map((server: ServerInstance) => ({ ...server, isActive: String(server.id) === selectedId })) })) as Promise<{
      servers: ServerInstance[];
      lifecycleCapabilities?: {
        supported: boolean;
        platform: string;
        containerized: boolean;
        providers: Array<"direct" | "systemd" | "openrc">;
      };
    }>;
  },
  getActive: () =>
    apiGet(`/servers/${encodeURIComponent(getSelectedServerId() || "none")}`) as Promise<{ server: ServerInstance }>,
  getComposedStatus: (options?: { retries?: number }) =>
    apiGet(`/servers/${encodeURIComponent(getSelectedServerId() || "none")}/status`, undefined, options?.retries) as Promise<ComposedServerStatus>,
  getResolvedActive: async () => {
    const data = await serversApi.getAll();
    return {
      server:
        data.servers.find((server) => server.isActive) ??
        data.servers[0] ??
        null,
    };
  },
  getStatus: (options?: { retries?: number }) =>
    apiGet("/servers/status", undefined, options?.retries) as Promise<{
      servers: Array<{
        id: string;
        name: string;
        running: boolean;
        pid: string | null;
        isActive: boolean;
        stateUnknown?: boolean;
      }>;
      detectedProcesses: number;
      detectionError: string | null;
    }>,
  getRconStatuses: () =>
    apiGet("/servers/rcon-status") as Promise<{
      servers: Array<{
        id: string;
        status:
          | "connected"
          | "unreachable"
          | "auth_failed"
          | "unconfigured"
          | "unavailable";
      }>;
    }>,
  get: (id: string | number) =>
    apiRoute("GET", "/servers/:id", { id: String(id) }) as Promise<{ server: ServerInstance }>,
  create: (
    config: Partial<ServerInstance> & {
      importIniFrom?: { dataPath: string; serverName: string };
    },
  ) =>
    apiRoute("POST", "/servers", config) as Promise<{
      server: ServerInstance;
      message: string;
    }>,
  update: (id: string | number, updates: Partial<ServerInstance>) =>
    apiPut(`/servers/${encodeURIComponent(String(id))}`, updates) as Promise<{
      server: ServerInstance;
      message: string;
      warnings?: string[];
    }>,
  getLifecycleTemplate: (
    id: string | number,
    provider: "systemd" | "openrc",
  ) =>
    apiRoute("GET", "/servers/:id/lifecycle-template", { id: String(id), provider }) as Promise<{
      provider: "systemd" | "openrc";
      serviceName: string;
      filename: string;
      installPath: string;
      content: string;
      commands: string[];
      warning: string;
    }>,
  activateLifecycleProvider: (
    id: string | number,
    provider: "direct" | "systemd" | "openrc",
  ) =>
    apiRoute("POST", "/servers/:id/lifecycle-provider", { id: String(id), provider, confirm: true }) as Promise<{
      server: ServerInstance;
      message: string;
    }>,
  delete: (id: string | number) =>
    apiRoute("DELETE", "/servers/:id", { id: String(id) }) as Promise<{
      success: boolean;
      message: string;
    }>,
  steamUpdate: (
    steamcmdPath: string,
    installPath: string,
    branch: string = "stable",
    serverId: string | number | null = getSelectedServerId(),
  ) =>
    apiPost(apiUrl("/server/steam-update", serverId === null ? null : String(serverId)).slice(4), {
      steamcmdPath,
      installPath,
      branch,
      validateFiles: false,
    }) as Promise<{ success: boolean; message: string }>,
  steamVerify: (
    steamcmdPath: string,
    installPath: string,
    branch: string = "stable",
    serverId: string | number | null = getSelectedServerId(),
  ) =>
    apiPost(apiUrl("/server/steam-update", serverId === null ? null : String(serverId)).slice(4), {
      steamcmdPath,
      installPath,
      branch,
      validateFiles: true,
    }) as Promise<{ success: boolean; message: string }>,

  discoverMounts: () =>
    apiRoute("GET", "/servers/discover-mounts") as Promise<{
      mounts: DiscoveredMount[];
    }>,

  createFromDiscovery: (data: {
    installPath: string;
    dataPath: string;
    serverName?: string;
    name?: string;
  }) =>
    apiRoute("POST", "/servers/create-from-discovery", data) as Promise<{
      server: ServerInstance;
      message: string;
    }>,
};

export interface DockerContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

export interface DockerContainerStats {
  cpuPercent: number;
  memoryUsed: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRx: number;
  networkTx: number;
  diskRead: number;
  diskWrite: number;
}

export const dockerApi = {
  getStatus: () => apiRoute("GET", "/docker/status") as Promise<{
    enabled: boolean;
    available: boolean;
    containers: DockerContainerSummary[];
  }>,
  getStats: () => apiRoute("GET", "/docker/stats") as Promise<{
    containers: Record<string, DockerContainerStats>;
  }>,
  runAction: (
    id: string,
    action: "start" | "stop" | "restart",
    serverId: string | number,
  ) =>
    apiRoute("POST", "/docker/containers/:id/:action", { id, action, serverId }) as Promise<{
      success: boolean;
      message?: string;
      error?: string;
    }>,
};

export interface SpawnPoint {
  worldX: number;
  worldY: number;
  posX: number;
  posY: number;
  posZ?: number;
}

export type SpawnPointsByProfession = Record<string, SpawnPoint[]>;

export interface SpawnRegion {
  name: string;
  file: string;
  isServerFile?: boolean;
}

export interface SandboxData {
  VERSION: number;
  settings: Record<string, string | number | boolean>;
  ZombieLore: Record<string, string | number | boolean>;
  ZombieConfig: Record<string, string | number | boolean>;
  MultiplierConfig: Record<string, string | number | boolean>;
  Map: Record<string, string | number | boolean>;
  Basement: Record<string, string | number | boolean>;
  Music?: Record<string, string | number | boolean>;
  Debug?: Record<string, string | number | boolean>;
}

export interface ConfigBackupFile {
  filename: string;
  size: number;
  created: string;
}

export interface BackupHistoryRecord {
  id: string;
  fileName: string;
  createdAt: string;
  size: number;
  serverId: string | number | null;
  serverName: string;
}

export interface BackupSnapshot {
  schemaVersion: number;
  createdAt: string;
  server: { id: string | number | null; name: string; provider: string };
  serverIni: Record<string, string>;
  sandboxVars: Record<string, string | number | boolean>;
}

export const serverFilesApi = {
  getPaths: () =>
    apiGet("/server-files/paths") as Promise<{
      serverId: string | number | null;
      configPath: string;
      serverName: string;
      files: {
        ini: string;
        sandbox: string;
        spawnpoints: string;
        spawnregions: string;
      };
      exists: {
        ini: boolean;
        sandbox: boolean;
        spawnpoints: boolean;
        spawnregions: boolean;
      };
    }>,

  getIni: () =>
    apiGet("/server-files/ini") as Promise<{
      settings: Record<string, string>;
      path: string;
      serverName: string;
      duplicateKeys?: Array<{ key: string; count: number }>;
    }>,
  saveIni: (settings: Record<string, string>, expectedServerId: string | number | null) =>
    apiPut("/server-files/ini", { settings, expectedServerId }) as Promise<{
      success: boolean;
      message: string;
      path: string;
      settings: Record<string, string>;
      restartRequired?: boolean;
    }>,

  getSandbox: () =>
    apiGet("/server-files/sandbox") as Promise<{
      sandbox: SandboxData;
      path: string;
      serverName: string;
    }>,
  saveSandbox: (sandbox: Partial<SandboxData>, expectedServerId: string | number | null) =>
    apiPut("/server-files/sandbox", { sandbox, expectedServerId }) as Promise<{
      success: boolean;
      created: boolean;
      message: string;
      path: string;
      unpersistedKeys?: string[];
      restartRequired?: boolean;
    }>,
  validateSandbox: () =>
    apiGet("/server-files/sandbox/validate") as Promise<{
      valid: boolean;
      braceDepth: number;
    }>,
  repairSandbox: () =>
    apiPost("/server-files/sandbox/repair") as Promise<{
      success: boolean;
      alreadyValid?: boolean;
      repaired?: boolean;
      changes?: string[];
      message?: string;
      error?: string;
      restartRequired?: boolean;
    }>,

  getSpawnPoints: () =>
    apiGet("/server-files/spawnpoints") as Promise<{
      spawnpoints: SpawnPointsByProfession;
      path: string;
    }>,
  saveSpawnPoints: (spawnpoints: SpawnPointsByProfession, expectedServerId: string | number | null) =>
    apiPut("/server-files/spawnpoints", { spawnpoints, expectedServerId }),

  getSpawnRegions: () =>
    apiGet("/server-files/spawnregions") as Promise<{
      spawnregions: SpawnRegion[];
      path: string;
    }>,
  saveSpawnRegions: (spawnregions: SpawnRegion[], expectedServerId: string | number | null) =>
    apiPut("/server-files/spawnregions", { spawnregions, expectedServerId }),

  getRaw: (type: "ini" | "sandbox" | "spawnpoints" | "spawnregions") =>
    apiGet(`/server-files/raw/${type}`) as Promise<{
      content: string;
      path: string;
      filename: string;
    }>,
  saveRaw: (
    type: "ini" | "sandbox" | "spawnpoints" | "spawnregions",
    content: string,
    expectedServerId: string | number | null,
  ) => apiPut(`/server-files/raw/${type}`, { content, expectedServerId }),

  getBackups: () =>
    apiGet("/server-files/backups") as Promise<{
      backups: ConfigBackupFile[];
      path: string;
    }>,
  restoreBackup: (filename: string, expectedServerId: string | number | null) =>
    apiPost(`/server-files/restore/${filename}`, { expectedServerId }),

  saveAndReload: (expectedServerId: string | number | null) =>
    apiPost("/server-files/save-and-reload", { expectedServerId }),

};

export interface GameIntegrationPlayer {
  username: string;
  displayName?: string;
  x?: number;
  y?: number;
  z?: number;
  accessLevel?: string;
  isAlive?: boolean;
  isAsleep?: boolean;
  isSneaking?: boolean;
  isRunning?: boolean;
  godMod?: boolean;
  invisible?: boolean;
  noclip?: boolean;
  hunger?: number;
  thirst?: number;
  fatigue?: number;
  stats?: {
    hunger?: number;
    thirst?: number;
    fatigue?: number;
    stress?: number;
    boredom?: number;
    unhappiness?: number;
    pain?: number;
    endurance?: number;
  };
  health?: {
    overallBodyHealth?: number;
    isInfected?: boolean;
    isBleeding?: boolean;
    temperature?: number;
  };
}

export type GameIntegrationPlayerDetails = GameIntegrationPlayer;

export interface GameIntegrationStatus {
  configured: boolean;
  isRunning: boolean;
  modConnected: boolean;
  path: string | null;
  modStatus: {
    alive: boolean;
    version: string;
    serverName: string;
    playerCount: number;
    players: string[];
    playerDetails?: GameIntegrationPlayerDetails[];
    world?: Record<string, unknown>;
    timestamp: number;
    age?: number;
    error?: string;
  } | null;
  connection: {
    healthy: boolean;
    canSendCommands: boolean;
    summary: string;
    issues: string[];
  } | null;
  localInstall: {
    installed: boolean;
    canAutoInstall: boolean;
    needsUpdate: boolean;
    restartRequired: boolean;
  };
}

export interface GameIntegrationActionResult {
  success: boolean;
  data?: {
    name?: string;
    value?: unknown;
    applied?: boolean;
    persisted?: boolean;
    restartRequired?: boolean;
    [key: string]: unknown;
  };
  error?: string;
}

export const gameIntegrationApi = {
  getStatus: () =>
    apiRoute("GET", "/game-integration/status") as Promise<GameIntegrationStatus>,
  install: () =>
    apiRoute("POST", "/game-integration/install", {}) as Promise<{
      success: boolean;
      message?: string;
      data?: { restartRequired?: boolean; [key: string]: unknown };
      error?: string;
    }>,
  getServerInfo: () =>
    apiRoute("GET", "/game-integration/server-info") as Promise<{
      success: boolean;
      data?: { players?: GameIntegrationPlayer[]; [key: string]: unknown };
      error?: string;
    }>,
  getWorldStats: () =>
    apiRoute("GET", "/game-integration/world/stats") as Promise<{
      success: boolean;
      data: { serverName: string; map: string; zombiesInCell: number };
    }>,
  getAllPlayerDetails: () =>
    apiRoute("GET", "/game-integration/players") as Promise<{
      success: boolean;
      data: { players: GameIntegrationPlayerDetails[] };
    }>,
  getPlayerDetails: (username: string) =>
    apiRoute("GET", "/game-integration/players/:username", { username }) as Promise<{
      success: boolean;
      data: GameIntegrationPlayerDetails;
      error?: string;
    }>,
  healPlayer: (username: string) =>
    apiRoute("POST", "/game-integration/players/:username/heal", { username }) as Promise<GameIntegrationActionResult>,
  killPlayer: (username: string) =>
    apiRoute("POST", "/game-integration/players/:username/kill", { username }) as Promise<GameIntegrationActionResult>,
  getSandbox: () => apiRoute("GET", "/game-integration/sandbox") as Promise<{
    values?: Record<string, unknown>;
    [key: string]: unknown;
  }>,
  getSandboxOptions: () =>
    apiRoute("GET", "/game-integration/sandbox/options") as Promise<{
      success?: boolean;
      data?: {
        options: Record<string, Array<Record<string, unknown>>>;
        groups: Array<{ name: string; count: number }>;
        totalCount: number;
        enumerated: boolean;
      };
      options?: Record<string, Array<Record<string, unknown>>>;
      groups?: Array<{ name: string; count: number }>;
      totalCount?: number;
      enumerated?: boolean;
      error?: string;
    }>,
  setSandboxOption: (name: string, value: unknown) =>
    apiRoute("PUT", "/game-integration/sandbox/options/:name", { name, value }) as Promise<GameIntegrationActionResult>,
  getCatalogItems: () =>
    apiRoute("GET", "/game-integration/catalog/items") as Promise<{
      items: Array<{ id: string; name: string; category: string; weight: number }>;
      count: number;
      scannedAt: string | null;
    }>,
  refreshCatalogItems: () =>
    apiRoute("POST", "/game-integration/catalog/items/refresh") as Promise<{
      items: Array<{ id: string; name: string; category: string; weight: number }>;
      count: number;
      scannedAt: string;
    }>,
};

export interface BackupSettings {
  enabled: boolean;
  schedule: string;
  maxBackups: number;
  waitMinutes: number;
  forceAfterMinutes: number | null;
  forceWarningMinutes: number;
}

export interface BackupStatus extends BackupSettings {
  backupInProgress: boolean;
  restoreInProgress: boolean;
  lastBackup: {
    name: string;
    path: string;
    size: number;
    created: string;
  } | null;
  backupCount: number;
  savesPath: string | null;
  backupsPath: string | null;
  savesExists: boolean;
  lastScheduledBackupAttempt: {
    success: boolean;
    message: string | null;
    executedAt: string;
  } | null;
}

export interface ServerBackupArchive {
  name: string;
  path: string;
  size: number;
  created: string;
}

export interface BackupContentsInfo {
  description: string;
  includes: string[];
  location: string;
  note: string;
}

export const backupApi = {
  getStatus: (): Promise<BackupStatus> => apiRoute("GET", "/backup/status"),

  getInfo: (): Promise<BackupContentsInfo> => apiRoute("GET", "/backup/info"),

  listBackups: (): Promise<{ backups: ServerBackupArchive[] }> =>
    apiRoute("GET", "/backup/list"),

  getHistory: (serverId?: string | number) =>
    apiRoute("GET", "/backup/history", { serverId }) as Promise<{
      records: BackupHistoryRecord[];
    }>,

  getSnapshot: (name: string): Promise<{ success: boolean; snapshot?: BackupSnapshot; message?: string }> =>
    apiRoute("GET", "/backup/:name/snapshot", { name }),

  updateSettings: (
    settings: Partial<BackupSettings>,
  ): Promise<{ success: boolean; settings: BackupSettings }> =>
    apiRoute("POST", "/backup/settings", settings),

  createBackup: (options?: {
    expectedServerId?: string | number | null;
  }): Promise<{
    success: boolean;
    backup?: ServerBackupArchive;
    duration?: number;
    message?: string;
    warnings?: string[];
  }> =>
    apiRoute("POST", "/backup/create", options || {}),

  deleteBackup: (
    name: string,
    expectedServerId?: string | number | null,
  ): Promise<{ success: boolean; message?: string }> =>
    apiRoute("DELETE", "/backup/:name", { name, expectedServerId }),

  restoreBackup: (
    name: string,
    options?: { expectedServerId?: string | number | null },
  ): Promise<{
    success: boolean;
    message?: string;
    duration?: number;
  }> =>
    apiPost(`/backup/restore/${encodeURIComponent(name)}`, options),

  deleteOlderThan: (
    days: number,
    expectedServerId?: string | number | null,
  ): Promise<{
    success: boolean;
    deleted?: number;
    failed?: number;
    deletedNames?: string[];
    message?: string;
  }> =>
    apiRoute("POST", "/backup/delete-older-than", { days, expectedServerId }),

  getDownloadUrl: (name: string): string =>
    apiUrl(`/backup/download/${encodeURIComponent(name)}`),

  uploadBackup: async (
    file: File,
    onProgress?: (percent: number) => void,
  ): Promise<{
    success: boolean;
    name: string;
    size: number;
    message: string;
  }> => {
    const uploadUrl = apiUrl("/backup/upload");
    const stallTimeoutMs = 3 * 60 * 1000;
    const sendOnce = (
      token: string | null,
    ): Promise<{ status: number; payload: any }> =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", uploadUrl, true);
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.setRequestHeader("Content-Type", "application/zip");
        xhr.setRequestHeader("X-Backup-Filename", file.name);
        let lastActivity = Date.now();
        let stalled = false;
        const stallCheck = setInterval(() => {
          if (Date.now() - lastActivity >= stallTimeoutMs) {
            stalled = true;
            xhr.abort();
          }
        }, 15_000);
        xhr.upload.onprogress = (e) => {
          lastActivity = Date.now();
          if (onProgress && e.lengthComputable) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
        xhr.onload = () => {
          clearInterval(stallCheck);
          let payload: any = null;
          try {
            payload = JSON.parse(xhr.responseText);
          } catch {
            /* non-JSON */
          }
          resolve({ status: xhr.status, payload });
        };
        xhr.onerror = () => {
          clearInterval(stallCheck);
          reject(new Error("Network error during upload"));
        };
        xhr.onabort = () => {
          clearInterval(stallCheck);
          reject(
            new Error(
              stalled
                ? "The upload stalled with no response from the server and was cancelled. Check your connection and try again."
                : "Upload aborted",
            ),
          );
        };
        xhr.send(file);
      });

    let { status, payload } = await sendOnce(getAuthToken());
    if (status === 401 && payload?.code === "TOKEN_EXPIRED") {
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        ({ status, payload } = await sendOnce(getAuthToken()));
      }
    }

    if (status >= 200 && status < 300 && payload?.success) {
      return payload;
    }
    throw new Error(payload?.error || `Upload failed (HTTP ${status})`);
  },

  downloadBackup: async (name: string): Promise<void> => {
    const response = await fetchWithRetry(
      apiUrl(`/backup/download/${encodeURIComponent(name)}`),
    );
    if (!response.ok) {
      const payload = await parseResponseBody(response);
      throw buildResponseError(response, payload);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
};

export const debugApi = {
  getRam: (): Promise<{
    totalGB: number;
    freeGB: number;
    recommendedMin: number;
    recommendedMax: number;
  }> => apiRoute("GET", "/debug/ram"),
  getPerformanceHistory: (
    limit: number = 30,
  ): Promise<{
    history: Array<{
      timestamp: string;
      playerCount: number;
      memoryUsed: number;
      pzMemUsed?: number;
      cpuUsage?: number;
      hostMemUsed?: number;
      hostMemTotal?: number;
    }>;
  }> => apiRoute("GET", "/debug/performance-history", { limit }),
};

export const authApi = {
  changePassword: (
    currentPassword: string,
    newPassword: string,
  ): Promise<{ success: boolean; message?: string }> =>
    apiRoute("POST", "/auth/change-password", { currentPassword, newPassword }),

  regenerateJwtSecret: (): Promise<{ success: boolean; message?: string }> =>
    apiRoute("POST", "/auth/regenerate-jwt-secret"),
};

export const serversDetectApi = {
  detect: (params: {
    dataPath: string;
    installPath?: string;
  }): Promise<Record<string, unknown>> =>
    apiPost("/servers/detect", params) as Promise<Record<string, unknown>>,
  autoScan: (params: {
    scanPath: string;
    maxDepth?: number;
  }): Promise<Record<string, unknown>> =>
    apiPost("/servers/auto-scan", params) as Promise<Record<string, unknown>>,
  deleteFiles: (path: string, serverId: string | number): Promise<unknown> =>
    apiRoute("POST", "/server/delete-files", { path, confirm: true, serverId }),
};

export interface UpdateStatus {
  updateAvailable: boolean;
  installed: {
    buildId: string;
    branch: string;
    lastUpdated: string | null;
  };
  latest: {
    buildId: string;
    branch: string;
    timeUpdated: string | null;
    description: string | null;
  };
  lastCheck: string;
}

export interface UpdateCheckerStatus {
  updateAvailable: UpdateStatus | null;
  gameVersion: string | null;
  lastCheck: string | null;
  intervalMinutes: number;
  isChecking: boolean;
  updating: boolean;
  lastUpdateResult: { success: boolean; message?: string; at: string } | null;
}

export interface PanelUpdateAsset {
  name: string;
  size?: number;
  downloadUrl?: string;
}

export interface PanelUpdateStatus {
  currentVersion: string;
  updateAvailable: boolean;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
  isChecking: boolean;
  isDownloading: boolean;
  downloadProgress: number;
  lastCheck: string | null;
  lastError: string | null;
  updateMode?: "binary" | "docker";
  updateCommand?: string | null;
  dockerInstallKind?: "aio" | "split" | null;
  stagedUpdate: { version: string | null; path: string } | null;
  lastApplyResult: PanelUpdateApplyResult | null;
}

export interface PanelUpdateApplyResult {
  message?: string;
  status: "success" | "failed";
  appliedVersion?: string;
  pendingVersion?: string;
  currentVersion?: string;
  at: string;

}

export interface PanelUpdateMessage {
  key: string;
  params?: Record<string, string | number>;
}

export interface PanelUpdatePreflight {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  blockerDetails?: PanelUpdateMessage[];
  warningDetails?: PanelUpdateMessage[];
  info: {
    isPackaged?: boolean;
    platform?: string;
    updateMode?: "binary" | "docker";
    alreadyCurrent?: boolean;
    exePath?: string;
    exeDir?: string;
    asset?: { name: string; size: number };
    writable?: boolean;
    freeBytes?: number | null;
    oneDrive?: boolean;
    syncSuspect?: boolean;
    programFiles?: boolean;
    stagedUpdate?: { version: string | null; path: string };
    oldPath?: string;
    temporaryDirectory?: string;
    applyLogPath?: string;
    restartAssessment?: RestartAssessment;
  };
}

export interface RestartAssessment {
  gameServers: "preserved" | "at-risk" | "unknown";
  requiresConfirmation: boolean;
  reason: string;
}

export interface PanelUpdateActionResult {
  success: boolean;
  message?: string;
  error?: string;
  preflight?: PanelUpdatePreflight;
}

export const updateApi = {
  check: (
    force: boolean = false,
  ): Promise<UpdateStatus | UpdateCheckerStatus> =>
    apiGet(`/server/update-check?force=${force}`),

  getStatus: (): Promise<UpdateCheckerStatus> =>
    apiGet("/server/update-check/status"),

  setInterval: (
    minutes: number,
  ): Promise<{ success: boolean; intervalMinutes: number }> =>
    apiPost("/server/update-check/interval", { minutes }),

  install: (): Promise<{ success: boolean; message: string }> => apiPost("/server/steam-update"),
};

export interface WorldMapLayer {
  id: string;
  name: string;
  tileRoot: string;
  width: number;
  height: number;
  tileSize: number;
  format: string;
  x0: number;
  y0: number;
  sqr: number;
  scale: number;
  minFloor: number;
  maxFloor: number;
  composite: boolean;
  cellSize: number;
  cellRects: Array<[number, number, number, number]>;
}

export interface WorldMapCoverage {
  ground: number;
  levels: Record<string, Record<string, Array<[number, number]>>>;
}

export interface WorldMapPoint { x: number; y: number; z: number }
export interface WorldMapPoi extends WorldMapPoint {
  id: string;
  name: string;
  tags: string[];
}

export interface WorldMapInfo {
  version: string;
  label: string;
  layers: WorldMapLayer[];
  mapOrder: string[];
  warnings: string[];
}

export const mapApi = {
  resolve: (): Promise<WorldMapInfo> => apiGet("/map/resolve", undefined, 0),
  coverage: (version: string, id: string): Promise<WorldMapCoverage> =>
    apiGet(`/map/coverage?${new URLSearchParams({ version, id })}`, undefined, 0),
  floor: (version: string, id: string, floor: number): Promise<{ format: string }> =>
    apiGet(`/map/floor?${new URLSearchParams({ version, id, floor: String(floor) })}`, undefined, 0),
  pois: (version: string): Promise<{ pois: WorldMapPoi[] }> =>
    apiGet(`/map/pois?${new URLSearchParams({ version })}`, undefined, 0),
  lootTypes: (version: string): Promise<{ types: Array<{ id: string; name: string; total: number }> }> =>
    apiGet(`/map/loot-types?${new URLSearchParams({ version })}`, undefined, 0),
  loot: (version: string, type: string, point: WorldMapPoint): Promise<{ points: WorldMapPoint[]; truncated: boolean }> =>
    apiGet(`/map/loot?${new URLSearchParams({ version, type, x: String(point.x), y: String(point.y), z: String(point.z) })}`, undefined, 0),
};

export const panelUpdateApi = {
  check: (): Promise<PanelUpdateStatus> => apiGet("/panel/update-check"),
  getStatus: (): Promise<PanelUpdateStatus> => apiGet("/panel/update-status"),
  preflight: (): Promise<PanelUpdatePreflight> =>
    apiGet("/panel/update-preflight"),
  install: (): Promise<PanelUpdateActionResult> =>
    apiPost("/panel/update", {}),
  getApplyLog: (): Promise<{ log: string | null; logPath: string }> =>
    apiGet("/panel/update-apply-log"),
};

export interface DiskSpaceStatus {
  path: string | null;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
  warning: boolean;
  critical: boolean;
  ok: boolean;
}

export interface DiskSpaceReport {
  saveVolume: DiskSpaceStatus | null;
  panelData: DiskSpaceStatus;
}

export interface StorageHealth {
  diskSpace: DiskSpaceReport;
  database: { ok: boolean; error: string | null };
}

export interface RuntimeInfo {
  platform: string;
  family: "windows" | "posix" | "unknown";
  pathSeparator: string;
  temporaryDirectory: string;
  serviceManager: "systemd" | "openrc" | "container" | "none" | "unknown";
  restartAssessment: RestartAssessment;
}

export const systemApi = {
  getDiskSpace: (): Promise<DiskSpaceReport> =>
    apiRoute("GET", "/system/disk-space"),
  getStorageHealth: (): Promise<StorageHealth> =>
    apiRoute("GET", "/system/storage-health"),
  getRuntime: (): Promise<RuntimeInfo> => apiRoute("GET", "/system/runtime"),
};
