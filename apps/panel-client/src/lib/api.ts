import { reportClientWarning } from "./client-errors";
import { clearAccessToken, getAccessToken, setAccessToken } from "./authToken";
import { toast } from "@/components/ui/use-toast";
import i18n from "@/i18n";
import type { LifecycleState } from "./serverStatus";
import {
  getDiskSpace,
  getRuntimeInfo,
  getStorageHealth,
} from "./serverSystem";
import {
  getCapabilities,
  getRoles,
} from "./serverPermissions";
import {
  assignManagedUserRole,
  changePassword,
  createManagedRole,
  createManagedUser,
  deleteManagedRole,
  generateRecoveryCodes,
  getAppSettings,
  getDebugRam,
  getManagedUsers,
  getOidcSettings,
  getPerformanceHistory,
  getRecoveryCodes,
  regenerateJwtSecret,
  removeManagedUser,
  clearCorsBlockedOrigins,
  getCorsDiagnostics,
  reloadCorsDiagnostics,
  testAppRconConnection,
  testOidcConnection,
  updateAppSettings,
  updateManagedRole,
  updateOidcSettings,
} from "./serverAdmin";
import {
  getBackupSnapshot,
  exportTemplate,
  getBackupHistory,
  getBackupInfo,
  getBackups,
  getBackupStatus,
  getHiddenTemplates,
  getPlayerActivity,
  getPlayerNote,
  getPlayerNotes,
  getPlayerStat,
  getPlayerStats,
  getTemplate,
  getTemplates,
} from "./serverResourceReadsRpc";
import {
  addCollectionItem,
  addIgnoredModPair,
  cancelPendingModRestart,
  clearAllIgnoredMods,
  deleteModPreset,
  getIgnoredModPairs,
  getIgnoredMods,
  getModPresets,
  getModsStatus,
  getServerMods,
  getTrackedMods,
  getWorkshopStatus,
  removeCollectionItem,
  removeCollectionTracking,
  removeIgnoredModPair,
  saveCollectionCookies,
  setModAutoRestart,
  setModRestartOptions,
  startModChecker,
  stopModChecker,
  trackMod,
  unignoreMod,
  untrackMod,
  updateModPreset,
} from "./serverModsRpc";
import {
  applyTemplate,
  createBackup as createBackupServer,
  createTemplate,
  deleteBackup,
  deleteBackupsOlderThan,
  deleteTemplate,
  importTemplate,
  previewTemplate,
  restoreBackup as restoreBackupServer,
  unhideTemplate,
  updateBackupSettings,
} from "./serverResourceActionsRpc";
import {
  getDiscordConfig,
  getDiscordPermissions,
  getDiscordStatus,
  getDiscordWebhookEvents,
  getDockerStats,
  getDockerStatus,
  resetDiscordConfig,
  runDockerAction,
  sendDiscordTestMessage,
  startDiscordBot,
  stopDiscordBot,
  testDiscordToken,
  updateDiscordConfig,
  updateDiscordPermissions,
  updateDiscordWebhookEvents,
} from "./serverIntegrationsRpc";
import {
  addAllToWhitelist,
  addAllowedSteamId,
  addPlayerItem,
  addPlayerVehicle,
  addPlayerVehicleAt,
  addPlayerXp,
  addRconUser,
  activateManagedLifecycleProvider,
  activateManagedServer,
  addToWhitelist,
  alarm,
  banPlayer,
  banSteamId,
  createScheduledTask,
  clearSchedulerHistory,
  connectRcon,
  createHorde,
  createManagedServer,
  createServerFromDiscovery,
  deleteScheduledTask,
  deleteManagedServer,
  disconnectRcon,
  executeRcon,
  getActiveManagedServer,
  getDiscoveredMounts,
  getGameServerStatus,
  getLifecycleTemplate,
  getManagedServer,
  getManagedServers,
  getNetworkInterfaces,
  getPlayerAccessLevels,
  getPlayerPerks,
  getPlayers,
  getPlayerVehicles,
  getRconCommands,
  getRconHistory,
  getRconStatus,
  getSchedulerHistory,
  getSchedulerPresets,
  getSchedulerStatus,
  getSchedulerTasks,
  getSteamIdBans,
  getWhitelist,
  kickPlayer,
  reloadLua,
  removeAllowedSteamId,
  removeFromWhitelist,
  removeZombies,
  releaseSafehouse,
  restartServer,
  restartScheduledServer,
  runScheduledTask,
  saveGameWorld,
  sendServerMessage,
  setAccessLevel,
  setGodMode,
  setInvisible,
  setLogLevel,
  setNoclip,
  setSchedulerRestartWarning,
  setSchedulerTimezone,
  setServerStats,
  setVoiceBan,
  startServer,
  startRain,
  startStorm,
  stopServer,
  stopRain,
  stopWeather,
  forceStopServer,
  teleportPlayer,
  testRconConnection,
  triggerChopper,
  triggerGunshot,
  triggerLightning,
  triggerThunder,
  updateScheduledTask,
  updateManagedServer,
  unbanPlayer,
  unbanSteamId,
  validateSchedulerCron,
} from "./serverGameControlRpc";
import { sendPanelBridgeCommand } from "./serverPanelBridgeRpc";
import {
  getPanelBridgeServerInfo,
  savePanelBridgeWorld,
  sendPanelBridgeWorldCommand,
} from "./serverPanelBridgeWorldRpc";
import {
  getPanelBridgeChatInfo,
  sendPanelBridgeAdminChat,
  sendPanelBridgeChatAlert,
  sendPanelBridgeGeneralChat,
  sendPanelBridgePlayerCommand,
  sendPanelBridgeServerMessage,
} from "./serverPanelBridgePlayerChatRpc";
import {
  getPanelBridgeCatalog,
  scanPanelBridgeCatalog,
  sendPanelBridgeEndangerCommand,
} from "./serverPanelBridgeEffectsRpc";
import { sendPanelBridgeDiagnosticsCommand } from "./serverPanelBridgeDiagnosticsRpc";
import {
  getPanelBridgeStatus,
  pingPanelBridge,
  sendPanelBridgeSetupCommand,
} from "./serverPanelBridgeSetupRpc";

const API_BASE = "/api";

export class ApiError extends Error {
  status?: number;
  code?: string;
  isRetryable: boolean;
  isTimeout: boolean;
  isNetworkError: boolean;
  data?: unknown;

  constructor(
    message: string,
    options?: {
      status?: number;
      code?: string;
      isRetryable?: boolean;
      isTimeout?: boolean;
      isNetworkError?: boolean;
      data?: unknown;
    },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = options?.status;
    this.code = options?.code;
    this.isRetryable = Boolean(options?.isRetryable);
    this.isTimeout = Boolean(options?.isTimeout);
    this.isNetworkError = Boolean(options?.isNetworkError);
    this.data = options?.data;
  }
}

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

async function serverCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    const result = await operation();
    if (result instanceof Response) {
      const payload = await parseResponseBody(result);
      if (!result.ok) throw buildResponseError(result, payload);
      showBackupWarning(payload);
      return payload as T;
    }
    showBackupWarning(result);
    return result;
  } catch (error) {
    throw toApiError(error);
  }
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
  return fetchWithRetry(`${API_BASE}${endpoint}`, options, retries);
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
    title: i18n.t("toastTitle", { ns: "backupWarning" }),
    description: backupWarning,
  });
}

function apiGet<T = any>(
  endpoint: string,
  options?: RequestInit & { timeout?: number },
  retries?: number,
): Promise<T> {
  return fetchWithRetry(`${API_BASE}${endpoint}`, options, retries).then((response) =>
    handleResponse<T>(response),
  );
}

function apiPost<T = any>(
  endpoint: string,
  body?: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  return fetchWithRetry(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: options?.signal,
  }).then((response) => handleResponse<T>(response));
}

function apiDelete<T = any>(endpoint: string): Promise<T> {
  return fetchWithRetry(`${API_BASE}${endpoint}`, { method: "DELETE" }).then(
    (response) => handleResponse<T>(response),
  );
}

function apiPut<T = any>(endpoint: string, body?: unknown): Promise<T> {
  return fetchWithRetry(`${API_BASE}${endpoint}`, {
    method: "PUT",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then((response) => handleResponse<T>(response));
}

export interface SteamBranch {
  name: string;
  description: string;
  buildId?: string | null;
  timeUpdated?: string | null;
}

export interface PerkData {
  level: number;
  xp: number;
}

export interface CharacterStats {
  hunger?: number;
  thirst?: number;
  fatigue?: number;
  stress?: number;
  boredom?: number;
  endurance?: number;
  health?: number;
  panic?: number;
  unhappyness?: number;
}

export interface CharacterInventoryItem {
  fullType: string;
  count?: number;
  condition?: number;
  uses?: number;
  delta?: number;
  contents?: CharacterInventoryItem[];
}

export interface CharacterExportData {
  username: string;
  exportTime?: number;
  perks: Record<string, PerkData>;
  stats?: CharacterStats;
  recipes: string[];
  traits?: string[];
  inventory?: CharacterInventoryItem[];
  wornItems?: Array<{ location: string; fullType: string; condition?: number }>;
  bagInventory?: Record<string, CharacterInventoryItem[]>;
  health?: {
    overall: number;
    infection?: number;
    bodyParts?: Array<{
      type: string;
      health: number;
      isBleeding: boolean;
      isBandaged: boolean;
      hasScratch: boolean;
      hasBite: boolean;
      isBurnt: boolean;
      isCut: boolean;
    }>;
  };
}

export interface CharacterExportResponse {
  success: boolean;
  data: CharacterExportData;
  error?: string;
}

export interface CharacterImportData {
  perks?: Record<string, PerkData>;
  stats?: CharacterStats;
  recipes?: string[];
  inventory?: CharacterInventoryItem[];
}

export interface CharacterImportResponse {
  success: boolean;
  data: {
    message: string;
    restored: {
      perks: number;
      items: number;
    };
  };
  error?: string;
}

export const serverApi = {
  getStatus: (_options?: { retries?: number }) =>
    serverCall(() => getGameServerStatus()),
  getNetworkInterfaces: (): Promise<{
    interfaces: { name: string; address: string }[];
  }> => serverCall(() => getNetworkInterfaces()),
  start: () => serverCall(() => startServer()),
  stop: () => serverCall(() => stopServer()),
  forceStop: () => serverCall(() => forceStopServer()),
  restart: (warningMinutes?: number) =>
    serverCall(() => restartServer({ data: { warningMinutes } })),
  restartNow: () =>
    serverCall(() => restartServer({ data: { warningMinutes: 0 } })),
  save: () => serverCall(() => saveGameWorld()),
  sendMessage: (message: string) =>
    serverCall(() => sendServerMessage({ data: { message } })),

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

  browseFolder: (initialPath?: string, description?: string) =>
    apiPost("/server/browse-folder", { initialPath, description }),
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

  startRain: (intensity?: number) =>
    serverCall(() => startRain({ data: { intensity } })),
  stopRain: () => serverCall(() => stopRain()),
  startStorm: (duration?: number) =>
    serverCall(() => startStorm({ data: { duration } })),
  stopWeather: () => serverCall(() => stopWeather()),

  triggerChopper: () => serverCall(() => triggerChopper()),
  triggerGunshot: () => serverCall(() => triggerGunshot()),
  triggerLightning: (username?: string) =>
    serverCall(() => triggerLightning({ data: { username } })),
  triggerThunder: (username?: string) =>
    serverCall(() => triggerThunder({ data: { username } })),
  createHorde: (count: number, username?: string) =>
    serverCall(() => createHorde({ data: { count, username } })),

  alarm: () => serverCall(() => alarm()),
  removeZombies: () => serverCall(() => removeZombies()),

  reloadLua: (filename: string) =>
    serverCall(() => reloadLua({ data: { filename } })),

  setLogLevel: (type: string, level: string) =>
    serverCall(() => setLogLevel({ data: { type, level } })),

  setStats: (mode: string, period?: number) =>
    serverCall(() => setServerStats({ data: { mode, period } })),

  releaseSafehouse: () => serverCall(() => releaseSafehouse()),

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
    serverCall(() => getPlayers()),
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
  }> => serverCall(() => getWhitelist()),
  kick: (username: string, reason?: string) =>
    serverCall(() => kickPlayer({ data: { username, reason } })),
  ban: (username: string, banIp?: boolean, reason?: string) =>
    serverCall(() => banPlayer({ data: { username, banIp, reason } })),
  unban: (username: string) =>
    serverCall(() => unbanPlayer({ data: { username } })),
  setAccessLevel: (username: string, level: string) =>
    serverCall(() => setAccessLevel({ data: { username, level } })),
  addToWhitelist: (username: string, password: string) =>
    serverCall(() => addToWhitelist({ data: { username, password } })),
  removeFromWhitelist: (username: string) =>
    serverCall(() => removeFromWhitelist({ data: { username } })),
  addAllowedSteamId: (steamId: string) =>
    serverCall(() => addAllowedSteamId({ data: { steamId } })),
  removeAllowedSteamId: (steamId: string) =>
    serverCall(() => removeAllowedSteamId({ data: { steamId } })),
  teleport: (
    player1: string,
    destination?: string | { x: number; y: number; z?: number },
  ) => {
    if (destination && typeof destination === "object") {
      return serverCall(() =>
        teleportPlayer({
          data: {
            player1,
            x: destination.x,
            y: destination.y,
            z: destination.z ?? 0,
          },
        }),
      );
    }

    return serverCall(() =>
      teleportPlayer({ data: { player1, player2: destination } }),
    );
  },
  addItem: (username: string | null, item: string, count?: number) =>
    serverCall(() => addPlayerItem({ data: { username, item, count } })),
  addXp: (username: string, perk: string, amount: number) =>
    serverCall(() => addPlayerXp({ data: { username, perk, amount } })),
  addVehicle: (vehicle: string, username?: string) =>
    serverCall(() => addPlayerVehicle({ data: { vehicle, username } })),
  addVehicleAt: (vehicle: string, x: number, y: number, z = 0) =>
    serverCall(() => addPlayerVehicleAt({ data: { vehicle, x, y, z } })),
  setGodMode: (username: string | null, enabled: boolean) =>
    serverCall(() => setGodMode({ data: { username, enabled } })),
  setInvisible: (username: string | null, enabled: boolean) =>
    serverCall(() => setInvisible({ data: { username, enabled } })),
  setNoclip: (username: string | null, enabled: boolean) =>
    serverCall(() => setNoclip({ data: { username, enabled } })),
  getVehicles: () => serverCall(() => getPlayerVehicles()),
  getPerks: () => serverCall(() => getPlayerPerks()),
  getAccessLevels: () => serverCall(() => getPlayerAccessLevels()),
  banSteamId: (steamId: string, reason?: string) =>
    serverCall(() => banSteamId({ data: { steamId, reason } })),
  unbanSteamId: (steamId: string) =>
    serverCall(() => unbanSteamId({ data: { steamId } })),
  getSteamIdBans: () => serverCall(() => getSteamIdBans()),
  voiceBan: (username: string, enabled: boolean) =>
    serverCall(() => setVoiceBan({ data: { username, enabled } })),
  addUser: (username: string, password: string) =>
    serverCall(() => addRconUser({ data: { username, password } })),
  addAllToWhitelist: () => serverCall(() => addAllToWhitelist()),
  getActivityLogs: (player?: string, limit?: number) =>
    getPlayerActivity({ data: { player, limit: limit || 100 } }),
  getNotes: () => getPlayerNotes(),
  getNote: (playerName: string) => getPlayerNote({ data: { playerName } }),
  saveNote: (playerName: string, note: string, tags: string[]) =>
    apiPost("/players/notes", { playerName, note, tags }),
  deleteNote: (playerName: string) =>
    apiDelete(`/players/notes/${encodeURIComponent(playerName)}`),
  getStats: () => getPlayerStats(),
  getStat: (playerName: string) => getPlayerStat({ data: { playerName } }),
  getExports: (username?: string) =>
    apiGet(
      `/players/exports${username ? `?username=${encodeURIComponent(username)}` : ""}`,
    ),
  getExport: (username: string, filename: string) =>
    apiGet(
      `/players/exports/${encodeURIComponent(username)}/${encodeURIComponent(filename)}`,
    ),
  deleteExport: (username: string, filename: string) =>
    apiDelete(
      `/players/exports/${encodeURIComponent(username)}/${encodeURIComponent(filename)}`,
    ),
};

export interface RconTestResult {
  success: boolean;
  error?: "unreachable" | "auth_failed" | "invalid_input" | "internal_error";
  detail: string;
}

export const rconApi = {
  execute: (command: string) =>
    serverCall(() => executeRcon({ data: { command } })),
  getStatus: () => serverCall(() => getRconStatus()),
  connect: (host?: string, port?: number, password?: string) =>
    serverCall(() => connectRcon({ data: { host, port, password } })),
  disconnect: () => serverCall(() => disconnectRcon()),
  getHistory: (limit?: number) =>
    serverCall(() => getRconHistory({ data: { limit } })),
  getCommands: () => serverCall(() => getRconCommands()),
  testConnection: (host: string, port: number, password: string) =>
    serverCall(() => testRconConnection({ data: { host, port, password } })),
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
  activeTasks: number;
  autoRestartEnabled: boolean;
  modUpdateRestartPending: boolean;
  timezone?: string;
  configuredTimezone?: string | null;
  timezoneFallback?: { configured: string; effective: string } | null;
  restartWarning?: RestartWarningSettings;
  restartWarningPresets?: Record<RestartWarningSettings["locale"], string>;
}

export const schedulerApi = {
  getStatus: () =>
    serverCall(() => getSchedulerStatus()) as Promise<SchedulerStatus>,
  getTasks: () => serverCall(() => getSchedulerTasks()),
  createTask: (
    name: string,
    cronExpression: string,
    command: string,
    serverId?: string | number,
  ) =>
    serverCall(() =>
      createScheduledTask({ data: { name, cronExpression, command, serverId } }),
    ),
  updateTask: (
    id: number,
    name: string,
    cronExpression: string,
    command: string,
    enabled: boolean,
    serverId?: string | number,
  ) =>
    serverCall(() =>
      updateScheduledTask({
        data: { id, name, cronExpression, command, enabled, serverId },
      }),
    ),
  deleteTask: (id: number) =>
    serverCall(() => deleteScheduledTask({ data: { id } })),
  runTask: (id: number) => serverCall(() => runScheduledTask({ data: { id } })),
  restartNow: (warningMinutes?: number) =>
    serverCall(() =>
      restartScheduledServer({ data: { warningMinutes } }),
    ) as Promise<{
      success: boolean;
      message: string;
      warningMinutes: number;
    }>,
  getCronPresets: () => serverCall(() => getSchedulerPresets()),
  validateCron: (cronExpression: string) =>
    serverCall(() => validateSchedulerCron({ data: { cronExpression } })) as Promise<{
      valid: boolean;
      error?: string;
      code?: string;
    }>,
  getHistory: (limit?: number, taskId?: number) => {
    return serverCall(() =>
      getSchedulerHistory({ data: { limit, taskId } }),
    ) as Promise<{
      history: ScheduleHistoryEntry[];
    }>;
  },
  clearHistory: () => serverCall(() => clearSchedulerHistory()),
  setTimezone: (timezone: string) =>
    serverCall(() => setSchedulerTimezone({ data: { timezone } })) as Promise<{
      success: boolean;
      timezone: string;
      configuredTimezone: string | null;
      timezoneFallback: { configured: string; effective: string } | null;
    }>,
  setRestartWarning: (restartWarning: RestartWarningSettings) =>
    serverCall(() =>
      setSchedulerRestartWarning({ data: restartWarning }),
    ) as Promise<{
      success: boolean;
      restartWarning: RestartWarningSettings;
    }>,
};

export const modsApi = {
  getStatus: (_options?: RequestInit) =>
    getModsStatus(),
  getTrackedMods: (_options?: RequestInit) =>
    getTrackedMods(),
  trackMod: (workshopId: string) =>
    serverCall(() => trackMod({ data: { workshopId } })),
  untrackMod: (workshopId: string) =>
    serverCall(() => untrackMod({ data: { workshopId } })),

  getIgnoredMods: () => getIgnoredMods(),
  unignoreMod: (workshopId: string) =>
    serverCall(() => unignoreMod({ data: { workshopId } })),
  clearAllIgnoredMods: () =>
    serverCall(() => clearAllIgnoredMods()),

  getIgnoredModPairs: () =>
    getIgnoredModPairs() as Promise<
      Array<{
        mod_a: string;
        mod_b: string;
        reason?: string | null;
        server_id?: string | null;
        ignored_at: string;
      }>
    >,
  addIgnoredModPair: (modIdA: string, modIdB: string, reason?: string) =>
    serverCall(() => addIgnoredModPair({ data: { modIdA, modIdB, reason } })),
  removeIgnoredModPair: (modIdA: string, modIdB: string) =>
    serverCall(() => removeIgnoredModPair({ data: { modIdA, modIdB } })),
  checkUpdates: (options?: { signal?: AbortSignal }) =>
    apiPost("/mods/check-updates", undefined, options),
  getServerMods: () => getServerMods(),
  syncFromServer: (options?: { signal?: AbortSignal }) =>
    apiPost("/mods/sync-from-server", undefined, options),
  clearUpdates: (options?: { signal?: AbortSignal }) =>
    apiPost("/mods/clear-updates", undefined, options),
  start: (_options?: { signal?: AbortSignal }) =>
    serverCall(() => startModChecker()),
  stop: (_options?: { signal?: AbortSignal }) =>
    serverCall(() => stopModChecker()),
  setAutoRestart: (enabled: boolean) =>
    serverCall(() => setModAutoRestart({ data: { enabled } })),
  setRestartOptions: (options: {
    warningMinutes?: number;
    delayIfPlayersOnline?: boolean;
    maxDelayMinutes?: number;
    checkInterval?: number;
  }) =>
    serverCall(() => setModRestartOptions({ data: options })),
  cancelPendingRestart: () =>
    serverCall(() => cancelPendingModRestart()),
  getWorkshopStatus: () => getWorkshopStatus(),

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
      autoSync: boolean;
      hasCredentials: boolean;
      tokenExpiry: number | null;
      tokenExpired: boolean;
      trackedCount: number;
      serverConfigRead?: boolean;
    }>,
  collectionAddItem: (workshopId: string) =>
    serverCall(() => addCollectionItem({ data: { workshopId } })) as Promise<{
      ok: true;
      workshopId: string;
      action: "add";
    }>,
  collectionRemoveItem: (workshopId: string) =>
    serverCall(() => removeCollectionItem({ data: { workshopId } })) as Promise<{
      ok: true;
      workshopId: string;
      action: "remove";
    }>,
  collectionUntrack: (workshopId: string) =>
    serverCall(() => removeCollectionTracking({ data: { workshopId } })) as Promise<{
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
      collection: { attempted: boolean; ok: boolean; error: string | null };
      deletedFromDisk: boolean;
      modIdsStripped: number;
      mapFoldersStripped: number;
    }>,
  collectionSync: () =>
    apiPost("/mods/collection/sync", {}) as Promise<{
      success: boolean;
      collectionId: string;
      added: string[];
      removed: string[];
      errors: Array<{ action: "add" | "remove"; id: string; error: string }>;
      message: string;
    }>,
  collectionTest: () =>
    apiPost("/mods/collection/test", {}) as Promise<{
      success: boolean;
      collectionId: string;
      title: string | null;
      itemCount: number;
      message: string;
    }>,
  collectionBrowsers: () =>
    apiGet("/mods/collection/browsers") as Promise<{
      supported: boolean;
      platform: string;
      browsers: Array<{
        id: string;
        label: string;
        family: string;
        detected: boolean;
      }>;
    }>,
  collectionExtractCookies: (browser: string) =>
    apiPost("/mods/collection/extract-cookies", { browser }) as Promise<{
      ok: boolean;
      browser: string;
      saved?: boolean;
      sessionid?: string | null;
      steamLoginSecure?: string | null;
      missing?: string[];
      notes?: string[];
      error?: string | null;
    }>,
  collectionSaveCookies: (sessionid: string, steamLoginSecure: string) =>
    serverCall(() => saveCollectionCookies({ data: { sessionid, steamLoginSecure } })) as Promise<{
      ok: boolean;
      message: string;
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

  getPresets: () => getModPresets(),
  createPreset: (name: string, description?: string) =>
    apiPost("/mods/presets", { name, description }),
  updatePreset: (
    id: number,
    data: {
      name?: string;
      description?: string;
      workshopIds?: string[];
      modIds?: string[];
    },
  ) =>
    serverCall(() => updateModPreset({ data: { id, ...data } })),
  deletePreset: (id: number) =>
    serverCall(() => deleteModPreset({ data: { id } })),
  applyPreset: (id: number) => apiPost(`/mods/presets/${id}/apply`),

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

export const chunksApi = {
  getSaves: (customPath?: string) =>
    apiGet(
      `/chunks/saves${customPath ? `?customPath=${encodeURIComponent(customPath)}` : ""}`,
      { timeout: 60000 },
    ),
  getChunks: (saveName: string, customPath?: string, scanId?: string) => {
    const params = new URLSearchParams();
    if (customPath) params.set("customPath", customPath);
    if (scanId) params.set("scanId", scanId);
    const qs = params.toString();
    return apiGet<Record<string, any> & { resolvedServerId?: string | number | null }>(
      `/chunks/chunks/${encodeURIComponent(saveName)}${qs ? `?${qs}` : ""}`,
      { timeout: 600000 },
    );
  },
  getStats: (saveName: string, customPath?: string) =>
    apiGet(
      `/chunks/stats/${encodeURIComponent(saveName)}${customPath ? `?customPath=${encodeURIComponent(customPath)}` : ""}`,
      { timeout: 60000 },
    ),
  deleteChunks: (
    saveName: string,
    chunks: Array<{
      file: string;
      x: number;
      y: number;
      source?: string;
      cellX?: number;
      cellY?: number;
    }>,
    createBackup: boolean = true,
    customPath?: string,
    deleteVehicles: boolean = false,
    force: boolean = false,
    expectedServerId: string | number | null = null,
  ) =>
    apiPost("/chunks/delete-chunks", {
      saveName,
      chunks,
      createBackup,
      customPath,
      deleteVehicles,
      force,
      expectedServerId,
    }),
  deleteRegion: (
    saveName: string,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    createBackup: boolean = true,
    invert: boolean = false,
    customPath?: string,
    deleteVehicles: boolean = false,
    force: boolean = false,
    expectedServerId: string | number | null = null,
  ) =>
    apiPost("/chunks/delete-region", {
      saveName,
      minX,
      maxX,
      minY,
      maxY,
      createBackup,
      invert,
      customPath,
      deleteVehicles,
      force,
      expectedServerId,
    }),
  browse: (browsePath?: string) =>
    apiGet(
      `/chunks/browse${browsePath ? `?path=${encodeURIComponent(browsePath)}` : ""}`,
    ),
  suggestedPaths: () =>
    apiGet<{
      candidates: Array<{ path: string; exists: boolean; hasSaves: boolean }>;
      platform: string;
    }>("/chunks/suggested-paths"),
  savePath: (p: string) =>
    apiPost<{
      ok: boolean;
      target: "server" | "setting";
      serverId?: string;
      path: string;
    }>("/chunks/save-path", { path: p }),
};

export const configApi = {
  getAppSettings: (): Promise<{ settings: Record<string, any> }> =>
    serverCall(() => getAppSettings()),
  updateAppSettings: (settings: Record<string, unknown>) =>
    serverCall(() => updateAppSettings({ data: { settings } })),
  getCorsDiagnostics: () =>
    serverCall(() => getCorsDiagnostics()) as Promise<{
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
    serverCall(() => reloadCorsDiagnostics()) as Promise<{
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
    serverCall(() => clearCorsBlockedOrigins()) as Promise<{
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
    serverCall(() => testAppRconConnection()),
};

export interface ConfigTestRconResult {
  success: boolean;
  connected: boolean;
  message?: string;
  warning?: boolean;
  error?: "unreachable" | "auth_failed";
  detail?: string;
}

export const discordApi = {
  getStatus: () => serverCall(() => getDiscordStatus()),
  getConfig: () => serverCall(() => getDiscordConfig()),
  updateConfig: (
    token: string,
    guildId: string,
    adminRoleId?: string,
    channelId?: string,
    autoStart?: boolean,
    modRoleId?: string,
    chatRelayEnabled?: boolean,
    chatRelayChannelId?: string,
    chatRelayScope?: "public" | "no-yell" | "general",
  ) =>
    serverCall(() =>
        updateDiscordConfig({
          data: {
            token,
            guildId,
            adminRoleId,
            modRoleId,
            channelId,
            autoStart,
            chatRelayEnabled,
            chatRelayChannelId,
            chatRelayScope,
          },
        })),
  resetConfig: () =>
    serverCall(() => resetDiscordConfig()),
  start: () =>
    serverCall(() => startDiscordBot()),
  stop: () =>
    serverCall(() => stopDiscordBot()),
  testToken: (token: string) =>
    serverCall(() => testDiscordToken({ data: { token } })),
  sendTestMessage: () =>
    serverCall(() => sendDiscordTestMessage()),
  getWebhookEvents: () =>
    serverCall(() => getDiscordWebhookEvents()),
  updateWebhookEvents: (
    events: Record<string, { enabled: boolean; template: string }>,
  ) =>
    serverCall(() => updateDiscordWebhookEvents({ data: { events } })),
  getPermissions: () =>
    serverCall(() => getDiscordPermissions()) as Promise<{
      permissions: Record<string, string>;
    }>,
  updatePermissions: (permissions: Record<string, string>) =>
    serverCall(() => updateDiscordPermissions({ data: { permissions } })) as Promise<{
      success: boolean;
      permissions: Record<string, string>;
    }>,
};

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
  isRemote: boolean;
  remoteConfigConfigured?: boolean;
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
  hasPanelBridge: boolean;
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
  bridge: ServerStatusSignal;
  summary: string;
}

export const serversApi = {
  getAll: () =>
    serverCall(() => getManagedServers()) as Promise<{
      servers: ServerInstance[];
      lifecycleCapabilities?: {
        supported: boolean;
        platform: string;
        containerized: boolean;
        providers: Array<"direct" | "systemd" | "openrc">;
      };
    }>,
  getActive: () =>
    serverCall(() => getActiveManagedServer()) as Promise<{ server: ServerInstance }>,
  getComposedStatus: (options?: { retries?: number }) =>
    apiGet("/servers/active/status", undefined, options?.retries) as Promise<ComposedServerStatus>,
  getResolvedActive: async () => {
    const data = (await getManagedServers()) as { servers: ServerInstance[] };
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
    serverCall(() => getManagedServer({ data: { id: String(id) } })) as Promise<{ server: ServerInstance }>,
  create: (
    config: Partial<ServerInstance> & {
      importIniFrom?: { dataPath: string; serverName: string };
    },
  ) =>
    serverCall(() => createManagedServer({ data: config })) as Promise<{
      server: ServerInstance;
      message: string;
    }>,
  update: (id: string | number, updates: Partial<ServerInstance>) =>
    serverCall(() => updateManagedServer({ data: { id: String(id), updates } })) as Promise<{
      server: ServerInstance;
      message: string;
      warnings?: string[];
    }>,
  getLifecycleTemplate: (
    id: string | number,
    provider: "systemd" | "openrc",
  ) =>
    getLifecycleTemplate({ data: { id: String(id), provider } }) as Promise<{
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
    serverCall(() =>
        activateManagedLifecycleProvider({
          data: { id: String(id), provider, confirm: true },
        })) as Promise<{
      server: ServerInstance;
      message: string;
    }>,
  delete: (id: string | number) =>
    serverCall(() => deleteManagedServer({ data: { id: String(id) } })) as Promise<{
      success: boolean;
      message: string;
    }>,
  activate: (id: string | number) =>
    serverCall(() => activateManagedServer({ data: { id: String(id) } })) as Promise<{
      server: ServerInstance;
      message: string;
    }>,
  steamUpdate: (
    steamcmdPath: string,
    installPath: string,
    branch: string = "stable",
  ) =>
    apiPost("/server/steam-update", {
      steamcmdPath,
      installPath,
      branch,
      validateFiles: false,
    }) as Promise<{ success: boolean; message: string }>,
  steamVerify: (
    steamcmdPath: string,
    installPath: string,
    branch: string = "stable",
  ) =>
    apiPost("/server/steam-update", {
      steamcmdPath,
      installPath,
      branch,
      validateFiles: true,
    }) as Promise<{ success: boolean; message: string }>,

  discoverMounts: () =>
    getDiscoveredMounts() as Promise<{
      mounts: DiscoveredMount[];
    }>,

  createFromDiscovery: (data: {
    installPath: string;
    dataPath: string;
    serverName?: string;
    name?: string;
  }) =>
    serverCall(() => createServerFromDiscovery({ data })) as Promise<{
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
  getStatus: () => serverCall(() => getDockerStatus()) as Promise<{
    enabled: boolean;
    available: boolean;
    containers: DockerContainerSummary[];
  }>,
  getStats: () => serverCall(() => getDockerStats()) as Promise<{
    containers: Record<string, DockerContainerStats>;
  }>,
  runAction: (
    id: string,
    action: "start" | "stop" | "restart",
    serverId: string | number,
  ) =>
    serverCall(() =>
        runDockerAction({
          data: { id, action, serverId },
        })) as Promise<{
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

export interface UtilitiesChangeResult {
  message?: string;
  power?: boolean;
  water?: boolean;
  hydroPowerOn?: boolean;
  debug?: string[];
  persisted?: boolean;
  persistReason?: string | null;
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

export interface ConfigTemplate {
  id: string;
  name: string;
  description: string;
  type: "ini" | "sandbox" | "both";
  created: string;
  modified: string;
  hasIni: boolean;
  hasSandbox: boolean;
}

export interface ConfigTemplateDetail extends ConfigTemplate {
  ini?: Record<string, string>;
  iniRaw?: string;
  sandboxRaw?: string;
  serverName?: string;
}

export const serverFilesApi = {
  getPaths: () =>
    apiGet("/server-files/paths") as Promise<{
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
  saveIni: (settings: Record<string, string>) =>
    apiPut("/server-files/ini", { settings }) as Promise<{
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
  saveSandbox: (sandbox: SandboxData) =>
    apiPut("/server-files/sandbox", { sandbox }) as Promise<{
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
  saveSpawnPoints: (spawnpoints: SpawnPointsByProfession) =>
    apiPut("/server-files/spawnpoints", { spawnpoints }),

  getSpawnRegions: () =>
    apiGet("/server-files/spawnregions") as Promise<{
      spawnregions: SpawnRegion[];
      path: string;
    }>,
  saveSpawnRegions: (spawnregions: SpawnRegion[]) =>
    apiPut("/server-files/spawnregions", { spawnregions }),

  getRaw: (type: "ini" | "sandbox" | "spawnpoints" | "spawnregions") =>
    apiGet(`/server-files/raw/${type}`) as Promise<{
      content: string;
      path: string;
      filename: string;
    }>,
  saveRaw: (
    type: "ini" | "sandbox" | "spawnpoints" | "spawnregions",
    content: string,
  ) => apiPut(`/server-files/raw/${type}`, { content }),

  getBackups: () =>
    apiGet("/server-files/backups") as Promise<{
      backups: ConfigBackupFile[];
      path: string;
    }>,
  restoreBackup: (filename: string) =>
    apiPost(`/server-files/restore/${filename}`),

  saveAndReload: () => apiPost("/server-files/save-and-reload"),

  saveSandboxOption: (
    name: string,
    value: string | number | boolean,
  ): Promise<{ success: boolean; persisted: boolean }> =>
    apiPut("/server-files/sandbox-option", { name, value }),

  getTemplates: () =>
    apiGet("/server-files/templates") as Promise<{
      templates: ConfigTemplate[];
    }>,
  getTemplate: (id: string) =>
    apiGet(`/server-files/templates/${id}`) as Promise<ConfigTemplateDetail>,
  saveAsTemplate: (data: {
    name: string;
    description?: string;
    includeIni?: boolean;
    includeSandbox?: boolean;
  }) =>
    apiPost("/server-files/templates", data) as Promise<{
      success: boolean;
      id: string;
      name: string;
      message: string;
    }>,
  applyTemplate: (
    id: string,
    options?: { applyIni?: boolean; applySandbox?: boolean },
  ) =>
    apiPost(`/server-files/templates/${id}/apply`, options || {}) as Promise<{
      success: boolean;
      applied: string[];
      message: string;
      backupWarnings?: string[];
    }>,
  updateTemplate: (id: string, data: { name?: string; description?: string }) =>
    apiPut(`/server-files/templates/${id}`, data),
  deleteTemplate: (id: string) => apiDelete(`/server-files/templates/${id}`),

  browseFiles: (browsePath?: string, extensions?: string[]) => {
    const params = new URLSearchParams();
    if (browsePath) params.set("path", browsePath);
    if (extensions?.length) params.set("extensions", extensions.join(","));
    return apiGet(`/server-files/browse-files?${params}`) as Promise<{
      currentPath: string;
      parent: string | null;
      directories: string[];
      files: { name: string; ext: string }[];
    }>;
  },
  fetchImagePreview: async (filePath: string): Promise<string> => {
    const response = await apiFetch(
      `/server-files/image-preview?path=${encodeURIComponent(filePath)}`,
    );
    if (!response.ok)
      throw new ApiError("Failed to load image preview", {
        status: response.status,
      });
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  },
};

export interface SimTemplateMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  pzBuild: string;
  createdAt?: string;
}

export interface SimTemplateModRef {
  workshopId: string;
  modId?: string;
  name?: string;
}

export type SimTemplateValueMap = Record<string, string | number | boolean>;

export interface SimTemplate {
  schemaVersion: number;
  meta: SimTemplateMeta;
  sandboxVars: Record<string, SimTemplateValueMap>;
  serverIni: SimTemplateValueMap;
  iniExclusions: string[];
  mods: SimTemplateModRef[];
  map: { mapId: string };
  difficulty: { level?: string };
  isBuiltin?: boolean;
}

export interface SimTemplateDiff {
  serverIni: Array<{ key: string; from: unknown; to: unknown }>;
  sandboxVars: Array<{
    section: string;
    key: string;
    from: unknown;
    to: unknown;
  }>;
  summary: { iniChanges: number; sandboxChanges: number; totalChanges: number };
}

export interface SimTemplateApplyResult {
  success: boolean;
  ini: { appliedKeys: string[] } | null;
  sandbox:
    | { applied: Array<{ section: string; key: string }>; skipped: Array<{ section: string; key: string }> }
    | { skipped: true; reason: string }
    | null;
  backups: string[];
  error?: string;
}

export const templatesApi = {
  list: () =>
    getTemplates() as Promise<{ templates: SimTemplate[] }>,
  get: (id: string) =>
    getTemplate({ data: { id } }) as Promise<{
      template: SimTemplate;
    }>,
  create: (input: Record<string, unknown>) =>
    serverCall(() => createTemplate({ data: input })) as Promise<{
      success: boolean;
      template?: SimTemplate;
      error?: string;
    }>,
  import: (template: unknown) =>
    serverCall(() => importTemplate({ data: { template } })) as Promise<{
      success: boolean;
      template?: SimTemplate;
      error?: string;
    }>,
  export: (id: string) =>
    exportTemplate({ data: { id } }) as Promise<SimTemplate>,
  downloadExport: async (id: string, filenameBase: string) => {
    const template = await exportTemplate({ data: { id } });
    const blob = new Blob([JSON.stringify(template, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filenameBase || id}.pztemplate.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
  preview: (id: string, serverId: string | number) =>
    serverCall(() => previewTemplate({ data: { id, serverId } })) as Promise<{ success: boolean; diff?: SimTemplateDiff; error?: string }>,
  apply: (
    id: string,
    serverId: string | number,
    options?: { backup?: boolean; applyIni?: boolean; applySandbox?: boolean },
  ) =>
    serverCall(() => applyTemplate({ data: { id, serverId, options } })) as Promise<SimTemplateApplyResult>,
  delete: (id: string) =>
    serverCall(() => deleteTemplate({ data: { id } })) as Promise<{
      success: boolean;
      error?: string;
    }>,
  listHidden: () =>
    getHiddenTemplates() as Promise<{ templates: SimTemplate[] }>,
  unhide: (id: string) =>
    serverCall(() => unhideTemplate({ data: { id } })) as Promise<{
      success: boolean;
      error?: string;
    }>,
};

export interface BridgeCommandResult<T = Record<string, unknown>> {
  success: boolean;
  data?: T & { verified?: "confirmed" | "unverifiable" };
  error?: string;
}

export const panelBridgeApi = {
  getStatus: () =>
    serverCall(() => getPanelBridgeStatus()) as Promise<{
      configured: boolean;
      bridgePath: string | null;
      isRunning: boolean;
      pendingCommands: number;
      modConnected: boolean;
      consecutiveFailures?: number;
      hasFileWatcher?: boolean;
      transport?: {
        type: "local" | "sftp";
        running: boolean;
        lastSyncAt?: number | null;
        lastLatencyMs?: number | null;
        lastError?: string | null;
        pollIntervalSeconds?: number | null;
      };
      config?: {
        statusStaleMs: number;
        pollIntervalMs: number;
        statusCheckMs: number;
      };
      statusFile?: {
        exists: boolean;
        path?: string;
        size?: number;
        modified?: string;
        age?: number;
        ageSeconds?: number;
        error?: string;
      };
      connection?: {
        healthy: boolean;
        canSendCommands: boolean;
        summary: string;
        issues: string[];
        checks: {
          bridgePathConfigured: boolean;
          bridgePathExists: boolean;
          bridgePathReadable: boolean;
          bridgePathWritable: boolean;
          commandsFilePresent: boolean;
          commandsFileReadable: boolean;
          resultsFilePresent: boolean;
          resultsFileReadable: boolean;
          statusFilePresent: boolean;
          statusFileReadable: boolean;
          statusFresh: boolean;
          statusAgeMs: number | null;
        };
      };
      modStatus: {
        alive: boolean;
        version: string;
        serverName: string;
        playerCount: number;
        players: string[];
        path: string;
        timestamp: number;
        age?: number;
        error?: string;
      } | null;
      detectedPaths: {
        serverName: string;
        installPath: string;
        zomboidDataPath: string;
      } | null;
    }>,

  autoConfigure: (serverId?: string | number) =>
    serverCall(() =>
        sendPanelBridgeSetupCommand({
          data: { action: "autoConfigure", args: { serverId } },
        })) as Promise<{
      success: boolean;
      message?: string;
      bridgePath: string;
      serverName: string;
      source: string;
      hasStatus: boolean;
      searchedPaths: Array<{
        path: string;
        source: string;
        hasStatus: boolean;
        hasInit: boolean;
      }>;
      error?: string;
    }>,

  scanForServer: (serverId: string | number) =>
    serverCall(() =>
        sendPanelBridgeSetupCommand({
          data: { action: "scanServer", args: { serverId } },
        })) as Promise<{
      success: boolean;
      serverName: string;
      paths: Array<{
        path: string;
        source: string;
        hasStatus: boolean;
        hasInit: boolean;
        exists: boolean;
      }>;
      recommendedPath: string | null;
      error?: string;
    }>,

  autoDetect: (serverName: string, zomboidUserFolder?: string) =>
    serverCall(() =>
        sendPanelBridgeSetupCommand({
          data: {
            action: "autoDetect",
            args: { serverName, zomboidUserFolder },
          },
        })),

  configure: (zomboidSavePath: string) =>
    serverCall(() =>
        sendPanelBridgeSetupCommand({
          data: { action: "configure", args: { zomboidSavePath } },
        })),

  configureDirect: (bridgePath: string) =>
    serverCall(() =>
        sendPanelBridgeSetupCommand({
          data: { action: "configureDirect", args: { bridgePath } },
        })) as Promise<{
      success: boolean;
      message?: string;
      bridgePath: string;
      error?: string;
    }>,

  configureSftp: (config: {
    host: string;
    port: string;
    username: string;
    password: string;
    bridgePath: string;
    pollIntervalSeconds: string;
  }) =>
    serverCall(() =>
        sendPanelBridgeSetupCommand({
          data: { action: "configureSftp", args: config },
        })) as Promise<{
    success: boolean;
    bridgePath: string;
    transport: { type: "sftp"; running: boolean; lastLatencyMs?: number | null };
  }>,

  listSftpLogs: (config: {
    host?: string;
    port?: string;
    username?: string;
    password?: string;
    logPath?: string;
  }) =>
    serverCall(() =>
        sendPanelBridgeSetupCommand({
          data: { action: "listSftpLogs", args: config },
        })) as Promise<{
    success: boolean;
    logPath: string;
    files: Array<{ name: string; size: number; modifiedAt: string | null }>;
  }>,

  listSftpConfigFiles: (config: {
    host?: string;
    port?: string;
    username?: string;
    password?: string;
    configPath?: string;
  }) =>
    serverCall(() =>
        sendPanelBridgeSetupCommand({
          data: { action: "listRemoteConfig", args: config },
        })) as Promise<{
    success: boolean;
    configPath: string;
    files: Array<{ name: string; size: number; modifiedAt: string | null }>;
  }>,

  tailSftpLog: (config: {
    name: string;
    maxBytes?: number;
    host?: string;
    port?: string;
    username?: string;
    password?: string;
    logPath?: string;
  }) =>
    serverCall(() =>
        sendPanelBridgeSetupCommand({
          data: { action: "tailSftpLog", args: config },
        })) as Promise<{
    success: boolean;
    name: string;
    size: number;
    truncated: boolean;
    bytesReturned: number;
    content: string;
  }>,

  testSftp: (config: {
    host: string;
    port: string;
    username: string;
    password: string;
    bridgePath: string;
    pollIntervalSeconds: string;
  }) =>
    serverCall(() =>
        sendPanelBridgeSetupCommand({
          data: { action: "testSftp", args: config },
        })) as Promise<{
    success: boolean;
    statusExists: boolean;
    foldersReady: boolean;
    latencyMs: number;
    nextStep: string;
  }>,

  start: () =>
    serverCall(() =>
        sendPanelBridgeSetupCommand({
          data: { action: "start", args: {} },
        })),

  stop: () =>
    serverCall(() =>
        sendPanelBridgeSetupCommand({
          data: { action: "stop", args: {} },
        })),

  refresh: () =>
    serverCall(() =>
        sendPanelBridgeSetupCommand({
          data: { action: "refresh", args: {} },
        })),

  scanPaths: () =>
    serverCall(() =>
        sendPanelBridgeSetupCommand({
          data: { action: "scanPaths", args: {} },
        })) as Promise<{
      foundBridges: Array<{
        path: string;
        serverName: string;
        baseDir: string;
        hasStatus: boolean;
        hasInit: boolean;
        statusAge: number | null;
        modVersion: string | null;
        isActive: boolean;
      }>;
      scannedDirs: string[];
      currentPath: string | null;
      isRunning: boolean;
      modConnected: boolean;
    }>,

  ping: () =>
    serverCall(() => pingPanelBridge()),

  sendCommand: (
    action: string,
    args?: Record<string, unknown>,
  ) =>
    serverCall(() => sendPanelBridgeCommand({ data: { action, args } })),

  triggerHelicopterEvent: () =>
    serverCall(() =>
        sendPanelBridgeCommand({
          data: { action: "triggerHelicopterEvent", args: {} },
        })),
  stopHelicopterEvent: () =>
    serverCall(() =>
        sendPanelBridgeCommand({
          data: { action: "stopHelicopterEvent", args: {} },
        })),

  getWeather: () =>
    serverCall(() => sendPanelBridgeWorldCommand({ data: { action: "getWeather" } })) as Promise<{
      success: boolean;
      data: {
        temperature: number;
        humidity: number;
        windSpeed: number;
        windAngle: number;
        fogIntensity: number;
        cloudIntensity: number;
        precipitationIntensity: number;
        isRaining: boolean;
        isSnowing: boolean;
        isThunderStorming: boolean;
        dayLight: number;
        nightStrength: number;
        desaturation: number;
        viewDistance: number;
        ambient: number;
      };
    }>,

  getServerInfo: () =>
    serverCall(() => getPanelBridgeServerInfo()),

  triggerBlizzard: (duration?: number) =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: { action: "triggerBlizzard", args: { duration } },
        })),
  triggerTropicalStorm: (duration?: number) =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: { action: "triggerTropicalStorm", args: { duration } },
        })),
  triggerStorm: (duration?: number) =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: { action: "triggerStorm", args: { duration } },
        })),
  stopWeather: () =>
    serverCall(() => sendPanelBridgeWorldCommand({ data: { action: "stopWeather" } })),
  setSnow: (enabled: boolean) =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: { action: "setSnow", args: { enabled } },
        })),
  generateWeather: (strength?: number, frontType?: number) =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: { action: "generateWeather", args: { strength, frontType } },
        })),

  startRain: (intensity?: number) =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: { action: "startRain", args: { intensity } },
        })),
  stopRain: () =>
    serverCall(() => sendPanelBridgeWorldCommand({ data: { action: "stopRain" } })),
  triggerLightning: (
    x?: number,
    y?: number,
    strike?: boolean,
    light?: boolean,
    rumble?: boolean,
  ) =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: {
            action: "triggerLightning",
            args: { x, y, strike, light, rumble },
          },
        })),

  getClimateFloats: () =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({ data: { action: "getClimateFloats" } })) as Promise<{
      success: boolean;
      data: {
        floats: Array<{
          id: number;
          name: string;
          actualName: string;
          value: number;
          min: number;
          max: number;
          isAdminEnabled: boolean;
        }>;
      };
  }>,
  setClimateFloat: (floatId: number, value: number, enable?: boolean) =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: {
            action: "setClimateFloat",
            args: { floatId, value, enable },
          },
        })),
  resetClimateOverrides: () =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: { action: "resetClimateOverrides" },
        })),

  getGameTime: () =>
    serverCall(() => sendPanelBridgeWorldCommand({ data: { action: "getGameTime" } })) as Promise<{
      success: boolean;
      data: {
        year: number;
        month: number;
        day: number;
        hour: number;
        minute: number;
        dayOfWeek: number;
        worldAgeHours: number;
        moonPhase: number;
        nightsSurvived: number;
        multiplier?: number;
      };
    }>,
  setGameTime: (options: {
    hour?: number;
    day?: number;
    month?: number;
    year?: number;
  }) =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: { action: "setGameTime", args: options },
        })),

  getWorldStats: () =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({ data: { action: "getWorldStats" } })) as Promise<{
      success: boolean;
      data: { serverName: string; map: string; zombiesInCell: number };
    }>,

  getZombieCount: () =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({ data: { action: "getZombieCount" } })) as Promise<{
      success: boolean;
      data: { zombieCount: number; note: string };
    }>,
  saveWorld: () =>
    serverCall(() => savePanelBridgeWorld()),

  getAllPlayerDetails: () =>
    serverCall(() =>
        sendPanelBridgePlayerCommand({
          data: { action: "getAllPlayerDetails" },
        })) as Promise<{
      success: boolean;
      data: {
        players: Array<{
          username: string;
          displayName: string;
          x: number;
          y: number;
          z: number;
          accessLevel: string;
          isAlive: boolean;
          hunger?: number;
          thirst?: number;
          fatigue?: number;
          health?: number;
          isInfected?: boolean;
        }>;
      };
    }>,
  getPlayerDetails: (username: string) =>
    serverCall(() =>
        sendPanelBridgePlayerCommand({
          data: { action: "getPlayerDetails", args: { username } },
        })) as Promise<{
      success: boolean;
      data: {
        username?: string;
        displayName?: string;
        x?: number;
        y?: number;
        z?: number;
        accessLevel?: string;
        isAlive?: boolean;
        isAsleep?: boolean;
        isSneaking?: boolean;
        isRunning?: boolean;
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
          health?: number;
          temperature?: number;
          wetness?: number;
        };
      };
      error?: string;
    }>,
  teleportPlayerBridge: (username: string, x: number, y: number, z?: number) =>
    serverCall(() =>
        sendPanelBridgePlayerCommand({
          data: {
            action: "teleportPlayer",
            args: { username, x, y, z },
          },
        })),

  killPlayer: (username: string) =>
    serverCall(() =>
        sendPanelBridgePlayerCommand({
          data: { action: "killPlayer", args: { username } },
        })),

  sendServerMessage: (message: string, color?: string) =>
    serverCall(() => sendPanelBridgeServerMessage({ data: { message, color } })),

  sendToServerChat: (message: string, alert?: boolean) =>
    serverCall(() =>
        sendPanelBridgeChatAlert({
          data: { message, alert: alert ?? false },
        })),

  sendToAdminChat: (message: string) =>
    serverCall(() => sendPanelBridgeAdminChat({ data: { message } })),

  sendToGeneralChat: (message: string, author?: string) =>
    serverCall(() =>
        sendPanelBridgeGeneralChat({
          data: { message, author: author?.trim() || "Server" },
        })),

  getChatInfo: () =>
    serverCall(() => getPanelBridgeChatInfo()) as Promise<{
      success: boolean;
      data: { chatServerAvailable: boolean; rconFallback: boolean };
    }>,

  getBridgeDebugStats: () =>
    serverCall(() =>
        sendPanelBridgeDiagnosticsCommand({
          data: { action: "getStats" },
        })) as Promise<BridgeCommandResult>,

  checkBridgeApi: (object?: string, method?: string) =>
    serverCall(() =>
        sendPanelBridgeDiagnosticsCommand({
          data: { action: "checkAPI", args: { object, method } },
        })) as Promise<BridgeCommandResult>,

  getBridgeAvailableHandlers: () =>
    serverCall(() =>
        sendPanelBridgeDiagnosticsCommand({
          data: { action: "getAvailableHandlers" },
        })) as Promise<BridgeCommandResult>,

  getBridgeDebugLog: (limit: number = 50, level: string = "DEBUG") =>
    serverCall(() =>
        sendPanelBridgeDiagnosticsCommand({
          data: {
            action: "getDebugLog",
            args: { limit, level },
          },
        })) as Promise<BridgeCommandResult>,

  runBridgeDebugItemScript: () =>
    serverCall(() =>
        sendPanelBridgeDiagnosticsCommand({
          data: { action: "debugItemScript" },
        })) as Promise<BridgeCommandResult>,

  setBridgeDebugMode: (enabled: boolean) =>
    serverCall(() =>
        sendPanelBridgeDiagnosticsCommand({
          data: { action: "setDebugMode", args: { enabled } },
        })) as Promise<BridgeCommandResult>,

  clearBridgeErrors: () =>
    serverCall(() =>
        sendPanelBridgeDiagnosticsCommand({
          data: { action: "clearErrors" },
        })) as Promise<BridgeCommandResult>,

  getSandboxOptions: () => apiGet("/panel-bridge/sandbox"),

  getCommands: () =>
    apiGet("/panel-bridge/commands") as Promise<{
      commands: Array<{
        action: string;
        description: string;
        args: Record<string, string>;
      }>;
    }>,

  getModPath: () =>
    apiGet("/panel-bridge/mod-path") as Promise<{
      modPath: string;
      exists: boolean;
      files: string[];
      suggestedInstallPath: string | null;
    }>,

  installModAuto: (serverId?: string | number) =>
    serverCall(() =>
        sendPanelBridgeSetupCommand({
          data: { action: "installModAuto", args: { serverId } },
        })) as Promise<{
      success: boolean;
      message: string;
      path: string;
      serverName: string;
      error?: string;
    }>,

  installMod: (serverLuaPath: string) =>
    apiPost("/panel-bridge/install-mod", { serverLuaPath }),


  playWorldSound: (
    x: number,
    y: number,
    z?: number,
    radius?: number,
    volume?: number,
  ) =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: {
            action: "playWorldSound",
            args: {
              x,
              y,
              z: z ?? 0,
              radius: radius ?? 50,
              volume: volume ?? 100,
            },
          },
        })),

  playSoundNearPlayer: (username: string, radius?: number, volume?: number) =>
    serverCall(() =>
        sendPanelBridgeEndangerCommand({
          data: {
            action: "playSoundNearPlayer",
            args: {
              username,
              radius: radius ?? 50,
              volume: volume ?? 100,
            },
          },
        })),

  triggerGunshotBridge: (options: {
    x?: number;
    y?: number;
    z?: number;
    username?: string;
  }) =>
    serverCall(() =>
        sendPanelBridgeEndangerCommand({
          data: { action: "triggerGunshot", args: options },
        })),

  triggerAlarmBridge: (options: {
    x?: number;
    y?: number;
    z?: number;
    username?: string;
  }) =>
    serverCall(() =>
        sendPanelBridgeEndangerCommand({
          data: { action: "triggerAlarmSound", args: options },
        })),

  createNoise: (options: {
    x?: number;
    y?: number;
    z?: number;
    radius?: number;
    volume?: number;
    username?: string;
  }) =>
    serverCall(() =>
        sendPanelBridgeEndangerCommand({
          data: { action: "createNoise", args: options },
        })),


  triggerAirdrop: (options: {
    x: number;
    y: number;
    preset?: "military" | "medical" | "food" | "building" | "weapons" | "tools";
    items?: Array<{ itemType: string; count?: number }>;
    announce?: boolean;
    attractZombies?: boolean;
    soundRadius?: number;
  }) => {
    if (!Number.isFinite(options.x) || !Number.isFinite(options.y)) {
      return Promise.reject(new Error("Invalid coordinates"));
    }
    return serverCall(() =>
        sendPanelBridgeCommand({
          data: {
            action: "airdrop",
            args: {
              ...options,
              x: Math.round(options.x),
              y: Math.round(options.y),
            },
          },
        }));
  },


  getUtilitiesStatus: () =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: { action: "getUtilitiesStatus" },
        })) as Promise<{
      success: boolean;
      data: {
        hydroPowerOn: boolean;
        powerOn: boolean;
        waterOn: boolean;
        elecShut: string;
        waterShut: string;
        elecShutModifier: number;
        waterShutModifier: number;
        currentWorldDay: number;
        nightsSurvived: number;
      };
    }>,

  restoreUtilities: (power?: boolean, water?: boolean) =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: {
            action: "restoreUtilities",
            args: { power: power !== false, water: water !== false },
          },
        })) as Promise<UtilitiesChangeResult>,

  shutOffUtilities: (power?: boolean, water?: boolean) =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: {
            action: "shutOffUtilities",
            args: { power: power !== false, water: water !== false },
          },
        })) as Promise<UtilitiesChangeResult>,


  exportCharacter: (username: string): Promise<CharacterExportResponse> =>
    apiPost("/panel-bridge/character/export", { username }),

  importCharacter: (
    username: string,
    data: CharacterImportData,
  ): Promise<CharacterImportResponse> =>
    apiPost("/panel-bridge/character/import", { username, data }),


  spawnHordeNear: (username: string, count: number) =>
    serverCall(() =>
        sendPanelBridgeEndangerCommand({
          data: {
            action: "spawnHordeNearPlayer",
            args: { username, count },
          },
        })),

  spawnHordeBehind: (username: string, count: number) =>
    serverCall(() =>
        sendPanelBridgeEndangerCommand({
          data: {
            action: "spawnHordeBehindPlayer",
            args: { username, count },
          },
        })),

  clearAllZombies: () =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: { action: "clearAllZombies" },
        })),
  clearZombiesNearPlayer: (username: string, radius?: number) =>
    serverCall(() =>
        sendPanelBridgeWorldCommand({
          data: {
            action: "clearZombiesNearPlayer",
            args: { username, radius },
          },
        })),


  getCatalogItems: () =>
    serverCall(() => getPanelBridgeCatalog({ data: { kind: "items" } })) as Promise<{
      items: Array<{
        id: string;
        name: string;
        category: string;
        weight: number;
      }>;
      count: number;
      scannedAt: string | null;
    }>,

  getCatalogVehicles: () =>
    serverCall(() => getPanelBridgeCatalog({ data: { kind: "vehicles" } })) as Promise<{
      vehicles: Array<{
        id: string;
        name: string;
        mass: number;
        seats: number;
      }>;
      count: number;
      scannedAt: string | null;
    }>,

  scanCatalogItems: () =>
    serverCall(() => scanPanelBridgeCatalog({ data: { kind: "items" } })) as Promise<{
      items: Array<{
        id: string;
        name: string;
        category: string;
        weight: number;
      }>;
      count: number;
      scannedAt: string;
    }>,

  scanCatalogVehicles: () =>
    serverCall(() => scanPanelBridgeCatalog({ data: { kind: "vehicles" } })) as Promise<{
      vehicles: Array<{
        id: string;
        name: string;
        mass: number;
        seats: number;
      }>;
      count: number;
      scannedAt: string;
    }>,
};

export interface BackupSettings {
  enabled: boolean;
  schedule: string;
  maxBackups: number;
  includeDb: boolean;
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
  getStatus: (): Promise<BackupStatus> => getBackupStatus(),

  getInfo: (): Promise<BackupContentsInfo> => getBackupInfo(),

  listBackups: (): Promise<{ backups: ServerBackupArchive[] }> =>
    getBackups(),

  getHistory: (serverId?: string | number) =>
    getBackupHistory({ data: { serverId } }) as Promise<{
      records: BackupHistoryRecord[];
    }>,

  getSnapshot: (name: string): Promise<{ success: boolean; snapshot?: BackupSnapshot; message?: string }> =>
    getBackupSnapshot({ data: { name } }),

  updateSettings: (
    settings: Partial<BackupSettings>,
  ): Promise<{ success: boolean; settings: BackupSettings }> =>
    serverCall(() => updateBackupSettings({ data: settings })),

  createBackup: (options?: {
    includeDb?: boolean;
  }): Promise<{
    success: boolean;
    backup?: ServerBackupArchive;
    duration?: number;
    message?: string;
  }> =>
    serverCall(() => createBackupServer({ data: options || {} })),

  deleteBackup: (
    name: string,
  ): Promise<{ success: boolean; message?: string }> =>
    serverCall(() => deleteBackup({ data: { name } })),

  restoreBackup: (
    name: string,
    options?: { createPreRestoreBackup?: boolean },
  ): Promise<{
    success: boolean;
    message?: string;
    duration?: number;
  }> =>
    serverCall(() => restoreBackupServer({ data: { name, options } })),

  deleteOlderThan: (
    days: number,
  ): Promise<{
    success: boolean;
    deleted?: number;
    failed?: number;
    deletedNames?: string[];
    message?: string;
  }> =>
    serverCall(() => deleteBackupsOlderThan({ data: { days } })),

  getDownloadUrl: (name: string): string =>
    `${API_BASE}/backup/download/${encodeURIComponent(name)}`,

  uploadBackup: async (
    file: File,
    onProgress?: (percent: number) => void,
  ): Promise<{
    success: boolean;
    name: string;
    size: number;
    message: string;
  }> => {
    const stallTimeoutMs = 3 * 60 * 1000;
    const sendOnce = (
      token: string | null,
    ): Promise<{ status: number; payload: any }> =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${API_BASE}/backup/upload`, true);
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
      `${API_BASE}/backup/download/${encodeURIComponent(name)}`,
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
  }> => serverCall(() => getDebugRam()),
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
  }> => serverCall(() => getPerformanceHistory({ data: { limit } })),
};

export const authApi = {
  changePassword: (
    currentPassword: string,
    newPassword: string,
  ): Promise<{ success: boolean; message?: string }> =>
    serverCall(() =>
      changePassword({ data: { currentPassword, newPassword } }),
    ),

  getRecoveryCodes: (): Promise<{
    configured: boolean;
    remaining: number;
    total: number;
    createdAt: string | null;
  }> => serverCall(() => getRecoveryCodes()),

  generateRecoveryCodes: (): Promise<{
    success: boolean;
    codes: string[];
    createdAt: string;
  }> => serverCall(() => generateRecoveryCodes()),

  regenerateJwtSecret: (): Promise<{ success: boolean; message?: string }> =>
    serverCall(() => regenerateJwtSecret()),
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
  deleteFiles: (path: string): Promise<unknown> =>
    apiPost("/server/delete-files", { path, confirm: true }),
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

export interface AutoUpdateResult {
  status: "success" | "failed";
  at: string;
  dismissed: boolean;
  reason?: string;
  params?: Record<string, string | number> | null;
  phase?: "not-started" | "before-stop" | "updating";
  serverUp?: boolean | null;
  appliedVersion?: string | null;
}

export interface UpdateCheckerStatus {
  updateAvailable: UpdateStatus | null;
  gameVersion: string | null;
  lastCheck: string | null;
  intervalMinutes: number;
  isChecking: boolean;
  lastAutoUpdateResult: AutoUpdateResult | null;
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
  stagedUpdate: { version: string | null; path: string } | null;
  lastApplyResult: PanelUpdateApplyResult | null;
}

export interface PanelUpdateApplyResult {
  status: "success" | "failed";
  appliedVersion?: string;
  pendingVersion?: string;
  currentVersion?: string;
  at: string;
  stagedStillPresent?: boolean;
  helperLog?: string | null;
  likelyCause?:
    | "helper_blocked"
    | "av_quarantine"
    | "rename_locked"
    | "permission"
    | "no_helper_log"
    | "rollback_failed"
    | "unknown";
  rollbackRetryLikely?: boolean;
  canRetryApply?: boolean;
  panelFolder?: string;
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
    dockerUpdater?: boolean;
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

  dismissAutoUpdateResult: (): Promise<UpdateCheckerStatus> =>
    apiPost("/server/update-check/auto-update-result/dismiss"),
};

export const mapApi = {
  resolve: (): Promise<{
    root: string;
    b42Dir: string;
    b41Path: string;
    tileSize: number;
    width: number;
    height: number;
    maxLevel: number;
    renderedMaxLevel: number;
    x0?: number;
    y0?: number;
    sqr?: number;
    scale?: number;
  }> => apiGet("/map/resolve"),
  vehicles: (): Promise<{ vehicles: Array<{ id: number; x: number; y: number }> }> =>
    apiGet("/map/vehicles"),
};

export const panelUpdateApi = {
  check: (): Promise<PanelUpdateStatus> => apiGet("/panel/update-check"),
  getStatus: (): Promise<PanelUpdateStatus> => apiGet("/panel/update-status"),
  preflight: (): Promise<PanelUpdatePreflight> =>
    apiGet("/panel/update-preflight"),
  download: (confirm: boolean = false): Promise<PanelUpdateActionResult> =>
    apiPost("/panel/update-download", { confirm }),
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

export interface CircuitBreakerStatus {
  open: boolean;
  lastError: string | null;
  failCount: number;
  cooldownEndsAt: string | null;
}

export interface StorageHealth {
  diskSpace: DiskSpaceReport;
  circuitBreaker: CircuitBreakerStatus;
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
    getDiskSpace(),
  getStorageHealth: (): Promise<StorageHealth> =>
    getStorageHealth(),
  getRuntime: (): Promise<RuntimeInfo> => getRuntimeInfo(),
};


export interface CapabilityInfo {
  key: string;
  label: string;
  description: string;
}

export interface CapabilityGroup {
  group: string;
  capabilities: CapabilityInfo[];
}

export interface RoleInfo {
  id: string;
  name: string;
  capabilities: string[];
  isSeeded: boolean;
  createdAt: string;
  updatedAt?: string;
  memberCount: number;
}

export const permissionsApi = {
  getCapabilities: (): Promise<{ groups: CapabilityGroup[] }> =>
    getCapabilities(),

  getRoles: (): Promise<{ roles: RoleInfo[] }> => getRoles(),

  createRole: (data: {
    name: string;
    capabilities: string[];
  }): Promise<{ success: boolean; role: RoleInfo }> =>
    serverCall(() => createManagedRole({ data })),

  updateRole: (
    id: string,
    data: {
      name?: string;
      capabilities?: string[];
      confirmSelfCapabilityLoss?: boolean;
    },
  ): Promise<{ success: boolean; role: RoleInfo }> =>
    serverCall(() => updateManagedRole({ data: { id, ...data } })),

  deleteRole: (
    id: string,
    reassignTo?: string,
  ): Promise<{
    success: boolean;
    deleted: boolean;
    reassigned: number;
    reassignedTo: string | null;
  }> => serverCall(() => deleteManagedRole({ data: { id, reassignTo } })),
};

export interface ManagedUserAccount {
  id: string;
  username: string;
  role: string;
  roleId: string | null;
  createdAt: string;
  lastLogin: string | null;
}

export const usersApi = {
  list: (): Promise<{ users: ManagedUserAccount[] }> =>
    serverCall(() => getManagedUsers()),

  create: (data: {
    username: string;
    password: string;
    role?: "admin" | "technician" | "moderator";
    roleId?: string;
  }): Promise<{ success: boolean; user: ManagedUserAccount }> =>
    serverCall(() => createManagedUser({ data })),

  assignRole: (
    userId: string,
    roleId: string,
  ): Promise<{ success: boolean; user: ManagedUserAccount }> =>
    serverCall(() => assignManagedUserRole({ data: { userId, roleId } })),

  remove: (
    userId: string,
  ): Promise<{ success: boolean; user: { id: string; username: string } }> =>
    serverCall(() => removeManagedUser({ data: { userId } })),
};

export interface OidcSettingsFields {
  issuerUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  providerName: string;
  allowInsecureHttp: boolean;
}

export interface OidcSettings extends OidcSettingsFields {
  clientSecretConfigured: boolean;
  configured: boolean;
}

export interface OidcSettingsWithEnv extends OidcSettings {
  envOverrides: Record<keyof OidcSettingsFields | "clientSecret", boolean>;
  suggestedRedirectUri: string;
}

export type OidcSettingsUpdate = Partial<OidcSettingsFields> & { clientSecret?: string };

export interface OidcDiscoveredMetadata {
  issuer: string;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  userinfoEndpoint: string | null;
  jwksUri: string | null;
  scopesSupported: string[];
}

export const oidcSettingsApi = {
  get: (): Promise<OidcSettingsWithEnv> =>
    serverCall(() => getOidcSettings()),

  update: (
    updates: OidcSettingsUpdate,
  ): Promise<{ success: boolean } & OidcSettings> =>
    serverCall(() => updateOidcSettings({ data: updates })),

  testConnection: (
    updates: OidcSettingsUpdate,
  ): Promise<{ success: true; metadata: OidcDiscoveredMetadata }> =>
    serverCall(() => testOidcConnection({ data: updates })),
};
