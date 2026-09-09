import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.ts";
import {
  createServer,
  deleteServer,
  getServer,
  getActiveServer,
  setActiveServer,
  setSetting,
  updateServer,
} from "../database/init.ts";
import {
  normalizeUserPath,
  inspectZomboidPath,
} from "../utils/zomboidPaths.ts";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "./lifecycleCoordinator.ts";
import { parseBoundedInteger } from "../utils/queryNumbers.ts";
import { normalizeMemoryGb } from "../utils/memory.ts";
import {
  isMaskedSecret,
  sanitizeError,
  sanitizeServerResponse,
} from "../utils/sanitize.ts";
import { resolveLaunchMode, ServerManager } from "./serverManager.ts";
import { applyUpnpToIni } from "../utils/upnpConfig.ts";
import {
  buildLifecycleTemplate,
  createLinuxServiceLifecycle,
  getLinuxLifecycleCapabilities,
  isManagedLifecycleProvider,
  LIFECYCLE_PROVIDERS,
} from "./linuxServiceLifecycle.ts";

const log = createLogger("ServerProfiles");

const RCON_HOST_REGEX = /^[a-zA-Z0-9.-]{1,255}$/;
const RCON_PASSWORD_MAX_LENGTH = 256;
const SERVER_NAME_REGEX =
  /^[a-zA-Z0-9_-][a-zA-Z0-9_\- ]*[a-zA-Z0-9_-]$|^[a-zA-Z0-9_-]$/;
const INSTALL_PATH_MAX_LENGTH = 1024;
const GAME_PORT_MAX = 65534;
const RCON_PORT_MAX = 65535;

const ALLOWED_SERVER_UPDATE_FIELDS = [
  "name",
  "serverName",
  "installPath",
  "serverPath",
  "zomboidDataPath",
  "serverConfigPath",
  "dockerContainerName",
  "branch",
  "rconHost",
  "rconPort",
  "rconPassword",
  "serverPort",
  "minMemory",
  "maxMemory",
  "useNoSteam",
  "useDebug",
  "useUpnp",
  "isRemote",
  "startCommand",
  "adminPassword",
] as const;

type JsonRecord = Record<string, any>;
export type ServerId = string | number;

export type ServerProfileRuntime = {
  rconService?: JsonRecord | null;
  serverManager?: JsonRecord | null;
  modChecker?: JsonRecord | null;
  io?: JsonRecord | null;
  refreshWorkshopChecker?: (modChecker: JsonRecord) => Promise<unknown>;
  autoInstallBridgeIfNeeded?: (server: JsonRecord) => void;
};

export class ServerProfileError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: JsonRecord;

  constructor(
    message: string,
    status = 400,
    code?: string,
    details?: JsonRecord,
  ) {
    super(message);
    this.name = "ServerProfileError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(
  message: string,
  status = 400,
  code?: string,
  details?: JsonRecord,
): never {
  throw new ServerProfileError(message, status, code, details);
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function parseServerId(value: unknown): ServerId | null {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return /^\d+$/.test(id) ? Number(id) : id;
}

function isValidServerName(value: unknown): value is string {
  return typeof value === "string" && SERVER_NAME_REGEX.test(value);
}

function isValidDockerContainerRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
  );
}

function validateInstallPathShape(value: unknown): {
  valid: boolean;
  error?: string;
} {
  if (typeof value !== "string" || !value.trim()) {
    return { valid: false, error: "Install path must be a non-empty string" };
  }
  if (value.length > INSTALL_PATH_MAX_LENGTH) {
    return { valid: false, error: "Install path is too long" };
  }
  if (/[\x00-\x1f]/.test(value)) {
    return { valid: false, error: "Install path contains invalid characters" };
  }
  const { mode } = resolveLaunchMode({ installPath: value });
  if (mode === "custom") return { valid: true };
  try {
    if (fs.existsSync(value) && !fs.statSync(value).isDirectory()) {
      return {
        valid: false,
        error:
          "Install path exists but is not a directory. If this is meant to point at a custom launcher script, its filename must end in .bat, .sh, or .exe.",
      };
    }
  } catch {
    // A later install/start operation reports an unusable path more precisely.
  }
  return { valid: true };
}

function parseIni(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator > 0) {
      result[trimmed.slice(0, separator).trim()] = trimmed
        .slice(separator + 1)
        .trim();
    }
  }
  return result;
}

async function withLifecycleLock<T>(
  id: unknown,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = acquireLifecycleLock("server-profile-change", String(id || ""));
  if (!lock) {
    const response = lifecycleInProgressResponse();
    fail(response.error, 409, response.code);
  }
  try {
    return await operation();
  } finally {
    lock.release();
  }
}

async function refreshWorkshopCheckerIfAvailable(
  runtime: ServerProfileRuntime,
): Promise<void> {
  if (!runtime.modChecker || !runtime.refreshWorkshopChecker) return;
  try {
    await runtime.refreshWorkshopChecker(runtime.modChecker);
  } catch (error: unknown) {
    log.warn(`Workshop checker refresh failed: ${errorMessage(error)}`);
  }
}

async function reloadServicesForActiveServer(
  runtime: ServerProfileRuntime,
  server: JsonRecord,
): Promise<void> {
  if (runtime.serverManager?.reloadConfig) {
    await runtime.serverManager.reloadConfig();
    log.info(`ServerManager reloaded config for server: ${server.name}`);
  }

  await refreshWorkshopCheckerIfAvailable(runtime);

  if (runtime.rconService?.isConnected?.()) {
    await runtime.rconService.disconnect();
  }

  if (runtime.rconService && server.rconPassword) {
    try {
      await runtime.rconService.reloadConfig();
      await runtime.rconService.connect();
      log.info(`RCON reconnected for server: ${server.name}`);
    } catch (error: unknown) {
      log.warn(`Failed to connect RCON for new server: ${errorMessage(error)}`);
    }
  }

  runtime.autoInstallBridgeIfNeeded?.(server);
}

export async function createServerProfile(
  input: unknown,
  options: { allowIniImport?: boolean } = {},
) {
  const config = { ...record(input) };

  if (config.importIniFrom && typeof config.importIniFrom === "object") {
    if (!options.allowIniImport) {
      fail("Importing an existing server requires servers.discover", 403);
    }

    const { dataPath: importDataPath, serverName: importServerName } = record(
      config.importIniFrom,
    );
    if (
      typeof importDataPath !== "string" ||
      importDataPath.length > 500 ||
      !path.isAbsolute(importDataPath)
    ) {
      fail("Invalid importIniFrom.dataPath");
    }
    if (!isValidServerName(importServerName)) {
      fail("Invalid importIniFrom.serverName");
    }

    const resolvedImportData = path.resolve(importDataPath);
    const importServerConfigPath = path.join(resolvedImportData, "Server");
    if (!fs.existsSync(importServerConfigPath)) {
      fail("Not a valid Zomboid data folder (no Server subfolder found)");
    }
    const importIniPath = path.join(
      importServerConfigPath,
      `${importServerName}.ini`,
    );
    if (!fs.existsSync(importIniPath)) {
      fail(`${importServerName}.ini not found`);
    }
    let importedSettings: Record<string, string>;
    try {
      importedSettings = parseIni(
        fs.readFileSync(importIniPath, "utf-8").replace(/\r\n/g, "\n"),
      );
    } catch (error: unknown) {
      fail(
        `Failed to read ${importServerName}.ini: ${sanitizeError(errorMessage(error))}`,
      );
    }
    if (!importedSettings.RCONPassword) {
      fail(
        `RCON password not set in ${importServerName}.ini — set RCONPassword on the server, then retry.`,
      );
    }
    config.rconPassword = importedSettings.RCONPassword;
    if (!config.serverName) config.serverName = importServerName;
    config.zomboidDataPath = resolvedImportData;
  }

  if (!config.installPath)
    config.installPath = process.env.PZ_SERVER_PATH || "";
  if (!config.zomboidDataPath) {
    config.zomboidDataPath = process.env.PZ_SAVE_PATH || null;
  }

  if (config.isRemote !== undefined && typeof config.isRemote !== "boolean") {
    fail("isRemote must be a boolean");
  }
  const isRemote = config.isRemote === true;
  const requiredFields = isRemote
    ? ["name", "rconHost", "rconPort", "rconPassword"]
    : ["name", "installPath", "rconHost", "rconPort", "rconPassword"];
  for (const field of requiredFields) {
    if (!config[field]) fail(`Missing required field: ${field}`);
  }

  if (!isRemote) {
    const pathCheck = validateInstallPathShape(config.installPath);
    if (!pathCheck.valid) fail(pathCheck.error!);
  }

  if (typeof config.name !== "string" || config.name.length > 100) {
    fail("Server name must be under 100 characters");
  }

  const rconPort = parseBoundedInteger(config.rconPort, null, 1, RCON_PORT_MAX);
  if (rconPort === null) fail("Invalid RCON port");
  if (
    typeof config.rconHost !== "string" ||
    !RCON_HOST_REGEX.test(config.rconHost.trim())
  ) {
    fail("Invalid RCON host");
  }
  if (
    typeof config.rconPassword !== "string" ||
    config.rconPassword.length > RCON_PASSWORD_MAX_LENGTH
  ) {
    fail("Invalid RCON password");
  }

  const serverName = String(config.serverName || config.name || "").trim();
  if (!isValidServerName(serverName)) {
    fail(
      config.serverName
        ? "Invalid server name: only letters, numbers, underscores, hyphens and spaces allowed"
        : "Server name is required, or give the server a display name that can be reused as one (letters, numbers, underscores, hyphens and spaces only)",
    );
  }

  const dockerContainerName = String(config.dockerContainerName || "").trim();
  if (dockerContainerName && !isValidDockerContainerRef(dockerContainerName)) {
    fail("Invalid Docker container name");
  }

  let serverPort = 16261;
  if (
    config.serverPort !== undefined &&
    config.serverPort !== null &&
    config.serverPort !== ""
  ) {
    const parsedServerPort = parseBoundedInteger(
      config.serverPort,
      null,
      1,
      GAME_PORT_MAX,
    );
    if (parsedServerPort === null) fail("Invalid server port");
    serverPort = parsedServerPort;
  }

  for (const key of ["useNoSteam", "useDebug", "useUpnp"]) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") {
      fail(`${key} must be a boolean`);
    }
  }

  const server = await createServer({
    name: config.name,
    serverName,
    installPath: config.installPath || "",
    zomboidDataPath: config.zomboidDataPath || null,
    serverConfigPath: config.serverConfigPath || null,
    dockerContainerName: dockerContainerName || null,
    branch: config.branch || "stable",
    rconHost: config.rconHost.trim(),
    rconPort,
    rconPassword: config.rconPassword,
    adminPassword: config.adminPassword || "",
    serverPort,
    minMemory: normalizeMemoryGb(config.minMemory, 4),
    maxMemory: normalizeMemoryGb(config.maxMemory, 8),
    useNoSteam: config.useNoSteam === true,
    useDebug: config.useDebug === true,
    useUpnp: config.useUpnp !== false,
    isRemote,
  });

  log.info(`Created new server: ${server.name} (ID: ${server.id})`);
  return server;
}

export async function updateServerProfile(
  id: unknown,
  input: unknown,
  runtime: ServerProfileRuntime = {},
) {
  return withLifecycleLock(id, async () => {
    const serverId = parseServerId(id);
    if (serverId === null) fail("Invalid server ID");

    const body = record(input);
    const updates: JsonRecord = {};
    for (const key of ALLOWED_SERVER_UPDATE_FIELDS) {
      if (body[key] !== undefined) updates[key] = body[key];
    }

    if (updates.serverName !== undefined) {
      if (typeof updates.serverName !== "string") fail("Invalid server name");
      const trimmed = updates.serverName.trim();
      if (!isValidServerName(trimmed)) {
        fail(
          "Invalid server name: only letters, numbers, underscores, hyphens and spaces allowed",
        );
      }
      updates.serverName = trimmed;
    }

    if (
      updates.name !== undefined &&
      (typeof updates.name !== "string" || updates.name.length > 100)
    ) {
      fail("Server name must be under 100 characters");
    }

    if (updates.dockerContainerName !== undefined) {
      if (
        updates.dockerContainerName !== null &&
        typeof updates.dockerContainerName !== "string"
      ) {
        fail("Invalid Docker container name");
      }
      const value = (updates.dockerContainerName || "").trim();
      if (value && !isValidDockerContainerRef(value)) {
        fail("Invalid Docker container name");
      }
      updates.dockerContainerName = value || null;
    }

    for (const key of ["installPath", "serverPath"]) {
      if (updates[key] !== undefined && updates[key] !== "") {
        const pathCheck = validateInstallPathShape(updates[key]);
        if (!pathCheck.valid) fail(pathCheck.error!);
      }
    }

    if (
      updates.zomboidDataPath !== undefined &&
      updates.zomboidDataPath !== ""
    ) {
      const effectiveIsRemote =
        updates.isRemote !== undefined
          ? updates.isRemote
          : Boolean((await getServer(serverId))?.isRemote);
      if (!effectiveIsRemote) {
        const normalized = normalizeUserPath(updates.zomboidDataPath);
        const resolved = normalized ? path.resolve(normalized) : null;
        if (!resolved || !fs.existsSync(resolved)) {
          fail(
            `Zomboid data path does not exist: ${resolved || updates.zomboidDataPath}. Check for typos and verify the panel has read access to this folder.`,
          );
        }
        let isDirectory = false;
        try {
          isDirectory = fs.statSync(resolved).isDirectory();
        } catch {
          isDirectory = false;
        }
        if (!isDirectory)
          fail(`Zomboid data path is not a directory: ${resolved}`);
        const verdict = inspectZomboidPath(resolved);
        if (!verdict.ok) {
          fail(
            verdict.reason === "install-folder"
              ? "This folder looks like a Project Zomboid server install, not a user data folder. Point at the Zomboid user data folder instead."
              : "This doesn't look like a Project Zomboid data folder (no Saves/Multiplayer directory or save files found there).",
          );
        }
        updates.zomboidDataPath = resolved;
      }
    }

    for (const key of ["rconPassword", "adminPassword"]) {
      if (updates[key] !== undefined && isMaskedSecret(updates[key])) {
        delete updates[key];
      }
    }

    if (updates.rconHost !== undefined) {
      if (
        typeof updates.rconHost !== "string" ||
        !RCON_HOST_REGEX.test(updates.rconHost.trim())
      ) {
        fail("Invalid RCON host");
      }
      updates.rconHost = updates.rconHost.trim();
    }

    if (
      updates.rconPassword !== undefined &&
      (typeof updates.rconPassword !== "string" ||
        updates.rconPassword.length > RCON_PASSWORD_MAX_LENGTH)
    ) {
      fail("Invalid RCON password");
    }

    if (updates.rconPort !== undefined) {
      const rconPort = parseBoundedInteger(
        updates.rconPort,
        null,
        1,
        RCON_PORT_MAX,
      );
      if (rconPort === null) fail("Invalid RCON port");
      updates.rconPort = rconPort;
    }

    if (updates.serverPort !== undefined) {
      const serverPort = parseBoundedInteger(
        updates.serverPort,
        null,
        1,
        GAME_PORT_MAX,
      );
      if (serverPort === null) fail("Invalid server port");
      updates.serverPort = serverPort;
    }

    if (updates.minMemory !== undefined) {
      updates.minMemory = normalizeMemoryGb(updates.minMemory, 4);
    }
    if (updates.maxMemory !== undefined) {
      updates.maxMemory = normalizeMemoryGb(updates.maxMemory, 8);
    }

    for (const key of ["useNoSteam", "useDebug", "isRemote", "useUpnp"]) {
      if (updates[key] !== undefined && typeof updates[key] !== "boolean") {
        fail(`${key} must be a boolean`);
      }
    }

    const maskedSecretsOnly =
      Object.keys(body).length > 0 &&
      Object.entries(body).every(
        ([key, value]) =>
          ["rconPassword", "adminPassword"].includes(key) &&
          isMaskedSecret(value),
      );
    if (Object.keys(updates).length === 0 && !maskedSecretsOnly) {
      fail("At least one field is required");
    }

    const server = await updateServer(serverId, updates);
    if (!server) fail("Server not found", 404);

    const reloadWarnings: string[] = [];
    if (server.isActive) {
      const rconFieldsChanged = ["rconHost", "rconPort", "rconPassword"].some(
        (key) => Object.prototype.hasOwnProperty.call(updates, key),
      );
      const serverManagerFieldsChanged = [
        "installPath",
        "serverPath",
        "zomboidDataPath",
        "serverConfigPath",
        "branch",
        "serverPort",
        "minMemory",
        "maxMemory",
        "useNoSteam",
        "useDebug",
        "startCommand",
        "serverName",
      ].some((key) => Object.prototype.hasOwnProperty.call(updates, key));

      if (serverManagerFieldsChanged && runtime.serverManager?.reloadConfig) {
        try {
          await runtime.serverManager.reloadConfig();
        } catch (error: unknown) {
          log.warn(
            `ServerManager reload failed after update: ${errorMessage(error)}`,
          );
          reloadWarnings.push(
            "Server manager failed to reload; restart the panel or server before relying on the updated settings",
          );
        }
      }

      if (rconFieldsChanged && runtime.rconService?.reloadConfig) {
        try {
          if (runtime.rconService.isConnected?.()) {
            await runtime.rconService.disconnect();
          }
          await runtime.rconService.reloadConfig();
          const reconnected = await runtime.rconService.connect();
          if (!reconnected) {
            reloadWarnings.push(
              "RCON could not reconnect; verify the updated connection settings",
            );
          }
        } catch (error: unknown) {
          log.warn(`RCON reload failed after update: ${errorMessage(error)}`);
          reloadWarnings.push(
            "RCON failed to reload; reconnect before relying on the updated connection settings",
          );
        }
      }

      if (Object.prototype.hasOwnProperty.call(updates, "installPath")) {
        await refreshWorkshopCheckerIfAvailable(runtime);
      }

      if (
        Object.prototype.hasOwnProperty.call(updates, "useUpnp") &&
        server.serverConfigPath &&
        server.serverName
      ) {
        const result = await applyUpnpToIni(
          server.serverConfigPath,
          server.serverName,
          updates.useUpnp,
        );
        if (result.applied) {
          await setSetting("useUpnp", updates.useUpnp);
          reloadWarnings.push(
            "UPnP setting saved and written to the server config -- takes effect the next time this server starts, not immediately.",
          );
        } else {
          log.warn(`Could not apply UPnP setting to ini: ${result.reason}`);
          reloadWarnings.push(
            `UPnP setting saved, but could not be applied to the server config (${result.reason}). Start the server once to generate its config file, then edit UPnP again.`,
          );
        }
      }
    }

    log.info(`Updated server: ${server.name} (ID: ${server.id})`);
    return {
      server,
      message: "Server updated successfully",
      ...(reloadWarnings.length > 0 ? { warnings: reloadWarnings } : {}),
    };
  });
}

export async function deleteServerProfile(
  id: unknown,
  runtime: ServerProfileRuntime = {},
) {
  return withLifecycleLock(id, async () => {
    const serverId = parseServerId(id);
    if (serverId === null) fail("Invalid server ID");

    const targetServer = await getServer(serverId);
    const deletingActiveServer = Boolean(targetServer?.isActive);
    if (!(await deleteServer(serverId))) fail("Server not found", 404);

    if (deletingActiveServer) {
      const newActiveServer = await getActiveServer();
      if (newActiveServer) {
        try {
          await reloadServicesForActiveServer(runtime, newActiveServer);
        } catch (error: unknown) {
          log.warn(
            `Failed to reload services after deleting the active server: ${errorMessage(error)}`,
          );
        }
        runtime.io?.emit?.("activeServerChanged", {
          server: sanitizeServerResponse(newActiveServer),
        });
      } else {
        runtime.io?.emit?.("activeServerChanged", { deleted: serverId });
      }
    } else {
      runtime.io?.emit?.("activeServerChanged", { deleted: serverId });
    }

    log.info(`Deleted server ID: ${serverId}`);
    return { success: true, message: "Server deleted successfully" };
  });
}

export async function activateServerProfile(
  id: unknown,
  runtime: ServerProfileRuntime = {},
) {
  return withLifecycleLock(id, async () => {
    const serverId = parseServerId(id);
    if (serverId === null) fail("Invalid server ID");

    const server = await setActiveServer(serverId);
    if (!server) fail("Server not found", 404);

    const reloadWarnings: string[] = [];
    try {
      await reloadServicesForActiveServer(runtime, server);
    } catch (error: unknown) {
      log.warn(
        `Failed to reload services after activating server: ${errorMessage(error)}`,
      );
      reloadWarnings.push(
        "Server activated, but live services could not be fully reloaded; restart the panel or reconnect RCON before relying on the new settings",
      );
    }

    runtime.io?.emit?.("activeServerChanged", {
      server: sanitizeServerResponse(server),
    });
    log.info(`Activated server: ${server.name} (ID: ${server.id})`);
    return {
      server,
      message: `Now managing: ${server.name}`,
      ...(reloadWarnings.length > 0 ? { warnings: reloadWarnings } : {}),
    };
  });
}

export async function getLifecycleTemplateForServer(
  id: unknown,
  provider: unknown,
  serviceUser?: unknown,
) {
  const serverId = parseServerId(id);
  if (serverId === null) fail("Invalid server ID");
  const providerName = String(provider || "").trim();
  if (!isManagedLifecycleProvider(providerName)) {
    fail("provider must be systemd or openrc");
  }
  const server = await getServer(serverId);
  if (!server) fail("Server not found", 404);
  if (
    server.isRemote ||
    server.dockerContainerName ||
    server.dockerContainerId
  ) {
    fail(
      "Managed Linux services are available only for local, non-container server profiles",
      409,
    );
  }
  const capabilities = getLinuxLifecycleCapabilities();
  if (!capabilities.supported) {
    fail(
      capabilities.containerized
        ? "Container installations must keep their existing lifecycle model"
        : "Managed service lifecycles are supported only on Linux",
      409,
    );
  }
  return {
    ...buildLifecycleTemplate(server, providerName, {
      serviceUser: typeof serviceUser === "string" ? serviceUser : undefined,
    }),
    warning:
      "Review and install this file for the panel service account. The panel will not modify the filesystem or run sudo.",
  };
}

export async function activateLifecycleProvider(
  id: unknown,
  provider: unknown,
  confirm: unknown,
  runtime: ServerProfileRuntime = {},
) {
  return withLifecycleLock(id, async () => {
    const serverId = parseServerId(id);
    if (serverId === null) fail("Invalid server ID");
    const providerName = String(provider || "").trim();
    if (
      !LIFECYCLE_PROVIDERS.includes(
        providerName as (typeof LIFECYCLE_PROVIDERS)[number],
      )
    ) {
      fail("provider must be direct, systemd, or openrc");
    }
    if (confirm !== true) {
      fail("Explicit lifecycle migration confirmation is required");
    }

    const server = await getServer(serverId);
    if (!server) fail("Server not found", 404);
    const currentProvider = server.lifecycleProvider || "direct";
    if (providerName === currentProvider) {
      return {
        server,
        message: `${providerName} lifecycle is already active`,
      };
    }
    if (
      server.isRemote ||
      server.dockerContainerName ||
      server.dockerContainerId
    ) {
      fail(
        "Remote and container-managed profiles must keep their existing lifecycle model",
        409,
      );
    }

    if (isManagedLifecycleProvider(providerName)) {
      const lifecycle = createLinuxServiceLifecycle(server, providerName);
      const preflight = await lifecycle.preflightActivation();
      if (!preflight.ready) {
        const conflict =
          "conflict" in preflight ? Boolean(preflight.conflict) : false;
        fail(
          sanitizeError(preflight.error),
          409,
          conflict ? "SERVER_LIFECYCLE_CONFLICT" : undefined,
          {
            conflict,
            running: Boolean(preflight.running),
          },
        );
      }

      const directManager = new ServerManager();
      await (
        directManager.reloadConfig as unknown as (
          id: ServerId,
        ) => Promise<unknown>
      )(serverId);
      const directStatus = await directManager.getServerProcessDetails();
      if (directStatus.scanFailed) {
        fail(
          "Could not confirm that the directly managed server is stopped",
          503,
        );
      }
      if (directStatus.running) {
        fail(
          "Stop the directly managed server before activating a service provider. Running processes are never adopted automatically.",
          409,
          undefined,
          { running: true },
        );
      }
    } else {
      const lifecycle = createLinuxServiceLifecycle(server, currentProvider);
      const currentStatus = await lifecycle.status();
      if (currentStatus.scanFailed || currentStatus.running) {
        fail(
          currentStatus.running
            ? "Stop the managed service before switching back to direct lifecycle"
            : "Could not confirm that the managed service is stopped",
          currentStatus.running ? 409 : 503,
          undefined,
          { running: Boolean(currentStatus.running) },
        );
      }
    }

    const updated = await updateServer(serverId, {
      lifecycleProvider: providerName,
    });
    if (updated?.isActive && runtime.serverManager?.reloadConfig) {
      await runtime.serverManager.reloadConfig();
    }
    return {
      server: updated,
      message: `Lifecycle provider changed to ${providerName}`,
    };
  });
}

export async function discoverMountsForServer() {
  const { discoverMounts, discoverMountIssues } =
    await import("./mountDiscovery.ts");
  return { mounts: discoverMounts(), inaccessible: discoverMountIssues() };
}

export async function createServerFromDiscovery(input: unknown) {
  const {
    discoverMounts,
    probeInstallPath,
    probeDataPath,
    readServerIniSettings,
  } = await import("./mountDiscovery.ts");
  const body = record(input);
  const { installPath, dataPath, serverName, name } = body;
  if (
    typeof installPath !== "string" ||
    typeof dataPath !== "string" ||
    !installPath ||
    !dataPath
  ) {
    fail("installPath and dataPath are required");
  }

  const normalizePath = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const discovered = discoverMounts().find(
    (mount) =>
      normalizePath(mount.installPath) === normalizePath(installPath) &&
      typeof mount.dataPath === "string" &&
      normalizePath(mount.dataPath) === normalizePath(dataPath),
  );
  if (!discovered) fail("Mount is not a discovered PZ server");
  if (typeof discovered.dataPath !== "string") {
    fail("Discovered mount has no data path");
  }

  const installResult = probeInstallPath(discovered.installPath);
  if (!installResult.valid) {
    fail("installPath does not look like a PZ server install");
  }
  const dataResult = probeDataPath(discovered.dataPath);
  if (!dataResult.valid) {
    fail("dataPath does not look like a PZ data folder");
  }

  const resolvedName =
    serverName || dataResult.serverNames[0] || installResult.serverNames[0];
  if (!resolvedName) {
    fail("No server config (Server/*.ini) found — specify serverName");
  }
  if (!SERVER_NAME_REGEX.test(resolvedName)) fail("Invalid serverName");
  if (
    discovered.serverNames.length > 0 &&
    !discovered.serverNames.includes(resolvedName)
  ) {
    fail("Server is not part of this mount");
  }

  const iniSettings = readServerIniSettings(discovered.dataPath, resolvedName);
  if (!iniSettings) {
    fail(
      `Could not read valid RCON or game port settings from ${resolvedName}.ini — fix the file, then retry.`,
    );
  }
  if (!iniSettings.rconPassword) {
    fail(
      `RCON password not set in ${resolvedName}.ini — set RCONPassword on the server, then retry.`,
    );
  }

  const server = await createServer({
    name: name || iniSettings.publicName || resolvedName,
    serverName: resolvedName,
    installPath: discovered.installPath,
    zomboidDataPath: discovered.dataPath,
    rconHost: "127.0.0.1",
    rconPort: iniSettings.rconPort,
    rconPassword: iniSettings.rconPassword,
    serverPort: iniSettings.serverPort,
    isRemote: false,
  });
  log.info(
    `Created server from discovered mount: ${server.name} (ID: ${server.id})`,
  );
  return server;
}
