import express from "express";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.ts";
const log = createLogger("API:Servers");
import {
  sanitizeError,
  sanitizeServerResponse,
  sanitizeServerResponseList,
  isMaskedSecret,
} from "../utils/sanitize.ts";
import { testRconConnection } from "../services/rcon.js";
import {
  getServers,
  getServer,
  getActiveServer,
  createServer,
  updateServer,
  deleteServer,
  setActiveServer,
  getAllSettings,
  setSetting,
} from "../database/init.js";
import { isRemoteConfigConfigured } from "../services/remoteConfigFiles.ts";
import { normalizeUserPath, inspectZomboidPath } from "../utils/zomboidPaths.ts";
import { requirePermission } from "../services/permissions.ts";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "../services/lifecycleCoordinator.ts";
import { autoInstallBridgeIfNeeded } from "../services/panelBridgeInstaller.ts";
import { refreshWorkshopChecker } from "../services/modChecker.js";
import {
  parseBoundedInteger,
  parseClampedInteger,
} from "../utils/queryNumbers.ts";
import { normalizeMemoryGb } from "../utils/memory.ts";
import { GAME_PORT_MAX, applyUpnpToIni } from "./server.js";
import {
  resolveLaunchMode,
  ServerManager,
} from "../services/serverManager.js";
import {
  buildLifecycleTemplate,
  createLinuxServiceLifecycle,
  getLinuxLifecycleCapabilities,
  isManagedLifecycleProvider,
  LIFECYCLE_PROVIDERS,
} from "../services/linuxServiceLifecycle.ts";

const router = express.Router();
const RCON_HOST_REGEX = /^[a-zA-Z0-9.-]{1,255}$/;
const RCON_PASSWORD_MAX_LENGTH = 256;

const SERVER_NAME_REGEX =
  /^[a-zA-Z0-9_-][a-zA-Z0-9_\- ]*[a-zA-Z0-9_-]$|^[a-zA-Z0-9_-]$/;

function isValidServerName(value) {
  return typeof value === "string" && SERVER_NAME_REGEX.test(value);
}

function isValidDockerContainerRef(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

const INSTALL_PATH_MAX_LENGTH = 1024;

function validateInstallPathShape(value) {
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
  if (mode === "custom") {
    return { valid: true, mode };
  }
  try {
    if (fs.existsSync(value) && !fs.statSync(value).isDirectory()) {
      return {
        valid: false,
        error:
          "Install path exists but is not a directory. If this is meant to point at a custom launcher script, its filename must end in .bat, .sh, or .exe.",
      };
    }
  } catch {
    // Unreadable (permissions, a transient mount hiccup) -- don't hard-fail
    // a save over a stat error; a genuinely unusable path still surfaces a
    // real error at install/start time.
  }
  return { valid: true, mode };
}

async function requireCapabilityInline(capability, req, res) {
  let passed = false;
  await requirePermission(capability)(req, res, () => {
    passed = true;
  });
  return passed;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
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

async function refreshWorkshopCheckerIfAvailable(req) {
  const modChecker = req.app.get("modChecker");
  if (!modChecker) return;

  try {
    await refreshWorkshopChecker(modChecker);
  } catch (error) {
    log.warn(`Workshop checker refresh failed: ${error.message}`);
  }
}

function parseIni(content) {
  const result = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
      continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

export function parseDiscoveredPort(value, fallback, max = 65535) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") return null;
  if (value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) return null;
  return parseBoundedInteger(value, null, 1, max);
}

function scanForPzPaths(rootPath, maxDepth = 3) {
  const results = {
    installPaths: [], // Folders containing PZ server startup scripts
    dataPaths: [], // Folders containing Server/ subfolder with .ini files
    customBatFiles: [], // Custom startup scripts found
  };

  function scan(currentPath, depth) {
    if (depth > maxDepth) return;

    try {
      if (
        !fs.existsSync(currentPath) ||
        !fs.statSync(currentPath).isDirectory()
      )
        return;

      const items = fs.readdirSync(currentPath);

      if (
        items.includes("StartServer64.bat") ||
        items.includes("StartServer64_nosteam.bat") ||
        items.includes("start-server.sh") ||
        (items.includes("jre64") && items.includes("ProjectZomboid64.json"))
      ) {
        results.installPaths.push(currentPath);

        const customScripts = items.filter(
          (f) =>
            (f.startsWith("StartServer_") && f.endsWith(".bat")) ||
            (f.startsWith("StartServer64_") &&
              f.endsWith(".bat") &&
              f !== "StartServer64_nosteam.bat") ||
            (f.startsWith("StartServer_") && f.endsWith(".sh")) ||
            (f.startsWith("start-server-") && f.endsWith(".sh")),
        );
        for (const script of customScripts) {
          let serverName = script
            .replace(/^StartServer(64)?_/, "")
            .replace(/^start-server-/, "")
            .replace(/\.(bat|sh)$/, "");
          results.customBatFiles.push({
            path: path.join(currentPath, script),
            folder: currentPath,
            fileName: script,
            serverName: serverName,
          });
        }
      }

      if (items.includes("Server")) {
        const serverPath = path.join(currentPath, "Server");
        if (
          fs.existsSync(serverPath) &&
          fs.statSync(serverPath).isDirectory()
        ) {
          const serverFiles = fs.readdirSync(serverPath);
          const hasIni = serverFiles.some(
            (f) =>
              f.endsWith(".ini") &&
              !f.endsWith("_SandboxVars.ini") &&
              !f.endsWith("_spawnpoints.ini") &&
              !f.endsWith("_spawnregions.ini"),
          );
          if (hasIni) {
            results.dataPaths.push(currentPath);
          }
        }
      }

      const skipFolders = [
        "node_modules",
        ".git",
        "logs",
        "Logs",
        "cache",
        "Saves",
        "mods",
        "steamapps",
        "depotcache",
        "appcache",
        "userdata",
        "media",
      ];
      for (const item of items) {
        if (skipFolders.includes(item)) continue;
        const itemPath = path.join(currentPath, item);
        try {
          if (fs.statSync(itemPath).isDirectory()) {
            scan(itemPath, depth + 1);
          }
        } catch (e) {
          log.debug(`Skipping inaccessible path ${itemPath}: ${e.message}`);
        }
      }
    } catch (e) {
      log.debug(`Skipping inaccessible folder ${currentPath}: ${e.message}`);
    }
  }

  scan(rootPath, 0);
  return results;
}

router.post("/auto-scan", requirePermission("servers.discover"), async (req, res) => {
  try {
    const { scanPath, maxDepth = 3 } = req.body || {};

    if (!scanPath) {
      return res.status(400).json({ error: "Scan path is required" });
    }

    if (typeof scanPath !== "string" || scanPath.length > 500) {
      return res.status(400).json({ error: "Invalid path format" });
    }

    if (!path.isAbsolute(scanPath)) {
      return res.status(400).json({ error: "Must be an absolute path" });
    }
    const resolvedPath = path.resolve(scanPath);

    const isRootPath =
      process.platform === "win32"
        ? /^[A-Za-z]:[\\/]?$/.test(resolvedPath)
        : resolvedPath === "/";
    if (isRootPath) {
      return res
        .status(400)
        .json({
          error: "Cannot scan a root path. Please specify a subfolder.",
        });
    }

    if (!fs.existsSync(resolvedPath)) {
      return res.status(400).json({ error: "Path does not exist" });
    }

    log.info(`Auto-scanning for PZ servers in: ${resolvedPath}`);

    const clampedDepth = parseClampedInteger(maxDepth, 3, 1, 3);
    const results = scanForPzPaths(resolvedPath, clampedDepth);

    const detectedConfigs = [];
    for (const dataPath of results.dataPaths) {
      const serverConfigPath = path.join(dataPath, "Server");
      const files = fs.readdirSync(serverConfigPath);
      const iniFiles = files.filter(
        (f) =>
          f.endsWith(".ini") &&
          !f.endsWith("_SandboxVars.ini") &&
          !f.endsWith("_spawnpoints.ini") &&
          !f.endsWith("_spawnregions.ini"),
      );

      for (const iniFile of iniFiles) {
        const serverName = iniFile.replace(".ini", "");
        const iniPath = path.join(serverConfigPath, iniFile);

        try {
          const content = fs
            .readFileSync(iniPath, "utf-8")
            .replace(/\r\n/g, "\n");
          const settings = parseIni(content);
          const rconPort = parseDiscoveredPort(settings.RCONPort, 27015);
          const serverPort = parseDiscoveredPort(settings.DefaultPort, 16261, GAME_PORT_MAX);
          if (rconPort === null || serverPort === null) {
            throw new Error("RCONPort or DefaultPort is invalid");
          }

          const matchingBat = results.customBatFiles.find(
            (bat) =>
              serverName.toLowerCase().includes(bat.serverName.toLowerCase()) ||
              bat.serverName.toLowerCase().includes(serverName.toLowerCase()),
          );

          detectedConfigs.push({
            dataPath,
            serverConfigPath,
            serverName,
            iniFile,
            rconPort,
            serverPort,
            publicName: settings.PublicName || serverName,
            hasRcon: !!settings.RCONPassword,
            matchedBatFile: matchingBat ? matchingBat.path : null,
            matchedInstallPath: matchingBat ? matchingBat.folder : null,
          });
        } catch (err) {
          log.warn(`Failed to parse ${iniFile}: ${err.message}`);
        }
      }
    }

    log.info(
      `Found ${results.installPaths.length} install paths, ${results.dataPaths.length} data paths, ${detectedConfigs.length} server configs, ${results.customBatFiles.length} custom bat files`,
    );

    res.json({
      scanPath,
      installPaths: results.installPaths,
      dataPaths: results.dataPaths,
      customBatFiles: results.customBatFiles,
      detectedConfigs,
    });
  } catch (error) {
    log.error(`Failed to auto-scan: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/detect", requirePermission("servers.discover"), async (req, res) => {
  try {
    const { dataPath, installPath } = req.body || {};
    log.info(
      `POST /detect: dataPath=${dataPath}, installPath=${installPath || "auto"}`,
    );

    if (!dataPath) {
      return res.status(400).json({ error: "Data path is required" });
    }

    if (typeof dataPath !== "string" || dataPath.length > 500) {
      return res.status(400).json({ error: "Invalid path format" });
    }

    if (!path.isAbsolute(dataPath)) {
      return res.status(400).json({ error: "Must be an absolute path" });
    }
    const resolvedData = path.resolve(dataPath);

    if (!fs.existsSync(resolvedData)) {
      return res.status(400).json({ error: "Data path does not exist" });
    }

    const serverConfigPath = path.join(resolvedData, "Server");
    if (!fs.existsSync(serverConfigPath)) {
      return res
        .status(400)
        .json({
          error: "Not a valid Zomboid data folder (no Server subfolder found)",
        });
    }

    let resolvedInstall = null;
    let hasNoSteam = false;
    let validInstallPath = false;
    if (installPath) {
      if (typeof installPath !== "string" || installPath.length > 500) {
        return res.status(400).json({ error: "Invalid install path format" });
      }
      if (!path.isAbsolute(installPath)) {
        return res.status(400).json({ error: "Install path must be absolute" });
      }
      resolvedInstall = path.resolve(installPath);
      if (fs.existsSync(resolvedInstall)) {
        const startBat = path.join(resolvedInstall, "StartServer64.bat");
        const startBatNoSteam = path.join(
          resolvedInstall,
          "StartServer64_nosteam.bat",
        );
        const startSh = path.join(resolvedInstall, "start-server.sh");
        validInstallPath =
          fs.existsSync(startBat) ||
          fs.existsSync(startBatNoSteam) ||
          fs.existsSync(startSh);
        hasNoSteam = fs.existsSync(startBatNoSteam);
      }
    }

    const detectedServers = [];

    if (fs.existsSync(serverConfigPath)) {
      const files = fs.readdirSync(serverConfigPath);
      const iniFiles = files.filter(
        (f) =>
          f.endsWith(".ini") &&
          !f.endsWith("_SandboxVars.ini") &&
          !f.endsWith("_spawnpoints.ini") &&
          !f.endsWith("_spawnregions.ini"),
      );

      for (const iniFile of iniFiles) {
        const serverName = iniFile.replace(".ini", "");
        const iniPath = path.join(serverConfigPath, iniFile);

        try {
          const content = fs
            .readFileSync(iniPath, "utf-8")
            .replace(/\r\n/g, "\n");
          const settings = parseIni(content);
          const rconPort = parseDiscoveredPort(settings.RCONPort, 27015);
          const serverPort = parseDiscoveredPort(settings.DefaultPort, 16261, GAME_PORT_MAX);
          if (rconPort === null || serverPort === null) {
            throw new Error("RCONPort or DefaultPort is invalid");
          }

          detectedServers.push({
            serverName,
            iniFile,
            rconPort,
            serverPort,
            publicName: settings.PublicName || serverName,
            hasRcon: !!settings.RCONPassword,
          });
        } catch (err) {
          log.warn(`Failed to parse ${iniFile}: ${err.message}`);
        }
      }
    }

    res.json({
      valid: true,
      dataPath: resolvedData,
      serverConfigPath,
      installPath: resolvedInstall || "",
      validInstallPath,
      hasNoSteam,
      detectedServers,
    });
  } catch (error) {
    log.error(`Failed to detect server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

function computeRemoteConfigConfigured(server, settings) {
  return server.isRemote ? isRemoteConfigConfigured(settings) : false;
}

router.get("/", async (req, res) => {
  try {
    const servers = await getServers();
    const settings = await getAllSettings();
    const withRemoteConfig = servers.map((server) => ({
      ...server,
      remoteConfigConfigured: computeRemoteConfigConfigured(server, settings),
    }));
    res.json({
      servers: sanitizeServerResponseList(withRemoteConfig),
      lifecycleCapabilities: getLinuxLifecycleCapabilities(),
    });
  } catch (error) {
    log.error(`Failed to get servers: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/status", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const servers = await getServers();
    const activeServer = await getActiveServer();
    const activeId = activeServer?.id || null;

    let matched = [];
    let detectionError = null;
    if (serverManager?.getServerProcessDetails) {
      try {
        const result = await serverManager.getServerProcessDetails();
        matched = Array.isArray(result?.matched) ? result.matched : [];
        if (result?.scanFailed) {
          detectionError = result.error || "Process detection failed";
        }
      } catch (err) {
        detectionError = err.message;
        log.debug(`Per-server status detection failed: ${err.message}`);
      }
    }

    const norm = (p) =>
      String(p || "")
        .toLowerCase()
        .replace(/\\/g, "/")
        .trim();

    const statuses = await Promise.all(servers.map(async (server) => {
      if (isManagedLifecycleProvider(server.lifecycleProvider)) {
        try {
          const status = await createLinuxServiceLifecycle(
            server,
            server.lifecycleProvider,
          ).status();
          return {
            id: server.id,
            name: server.name,
            running: status.running,
            pid: null,
            isActive: server.id === activeId,
            provider: server.lifecycleProvider,
            stateUnknown: Boolean(status.scanFailed),
          };
        } catch (error) {
          return {
            id: server.id,
            name: server.name,
            running: false,
            pid: null,
            isActive: server.id === activeId,
            provider: server.lifecycleProvider,
            stateUnknown: true,
            error: sanitizeError(error.message),
          };
        }
      }
      const installPathNorm = norm(server.installPath);
      let running = false;
      let pid;
      if (installPathNorm) {
        for (const m of matched) {
          if (norm(m.cmd).includes(installPathNorm)) {
            running = true;
            pid = m.pid;
            break;
          }
        }
      }
      if (!running && server.id === activeId && serverManager?.isRunning) {
        running = true;
      }
      return {
        id: server.id,
        name: server.name,
        running,
        pid: pid || null,
        isActive: server.id === activeId,
        provider: "direct",
        stateUnknown: Boolean(detectionError),
      };
    }));

    res.json({
      servers: statuses,
      detectedProcesses: matched.length,
      detectionError,
    });
  } catch (error) {
    log.error(`Failed to get per-server status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/rcon-status", async (req, res) => {
  try {
    const servers = await getServers();
    const statuses = await mapWithConcurrency(servers, 3, async (server) => {
      const rconHost =
        typeof server.rconHost === "string" ? server.rconHost.trim() : "";
      const rconPort = parseBoundedInteger(server.rconPort, null, 1, 65535);
      if (
        !rconHost ||
        server.rconPort === undefined ||
        server.rconPort === null ||
        server.rconPort === ""
      ) {
        return { id: server.id, status: "unconfigured" };
      }
      if (rconPort === null) return { id: server.id, status: "unavailable" };
      const result = await testRconConnection({
        host: rconHost,
        port: rconPort,
        password: server.rconPassword || "",
        timeoutMs: 3000,
      });
      return {
        id: server.id,
        status: result.success ? "connected" : result.error || "unavailable",
      };
    });
    res.json({ servers: statuses });
  } catch (error) {
    log.error(`Failed to probe server RCON status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/active", async (req, res) => {
  try {
    const server = await getActiveServer();
    if (!server) {
      return res.status(404).json({ error: "No active server configured" });
    }
    const remoteConfigConfigured = computeRemoteConfigConfigured(
      server,
      await getAllSettings(),
    );
    res.json({
      server: sanitizeServerResponse({ ...server, remoteConfigConfigured }),
    });
  } catch (error) {
    log.error(`Failed to get active server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: "Invalid server ID" });
    }
    const serverId = parseServerId(id);
    if (serverId === null) {
      return res.status(400).json({ error: "Invalid server ID" });
    }

    const server = await getServer(serverId);
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    res.json({ server: sanitizeServerResponse(server) });
  } catch (error) {
    log.error(`Failed to get server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get(
  "/:id/lifecycle-template",
  requirePermission("servers.manage"),
  async (req, res) => {
    try {
      const serverId = parseServerId(req.params.id);
      if (serverId === null) {
        return res.status(400).json({ error: "Invalid server ID" });
      }
      const provider = String(req.query?.provider || "").trim();
      if (!isManagedLifecycleProvider(provider)) {
        return res.status(400).json({
          error: "provider must be systemd or openrc",
        });
      }
      const server = await getServer(serverId);
      if (!server) {
        return res.status(404).json({ error: "Server not found" });
      }
      if (server.isRemote || server.dockerContainerName || server.dockerContainerId) {
        return res.status(409).json({
          error:
            "Managed Linux services are available only for local, non-container server profiles",
        });
      }
      const capabilities = getLinuxLifecycleCapabilities();
      if (!capabilities.supported) {
        return res.status(409).json({
          error: capabilities.containerized
            ? "Container installations must keep their existing lifecycle model"
            : "Managed service lifecycles are supported only on Linux",
        });
      }
      const template = buildLifecycleTemplate(server, provider, {
        serviceUser: req.query?.serviceUser,
      });
      res.json({
        ...template,
        warning:
          "Review and install this file for the panel service account. The panel will not modify the filesystem or run sudo.",
      });
    } catch (error) {
      log.error(`Failed to generate lifecycle template: ${error.message}`);
      res.status(400).json({ error: sanitizeError(error.message) });
    }
  },
);

router.post(
  "/:id/lifecycle-provider",
  requirePermission("servers.manage"),
  async (req, res) => {
    try {
      const serverId = parseServerId(req.params.id);
      if (serverId === null) {
        return res.status(400).json({ error: "Invalid server ID" });
      }
      const provider = String(req.body?.provider || "").trim();
      if (!LIFECYCLE_PROVIDERS.includes(provider)) {
        return res.status(400).json({
          error: "provider must be direct, systemd, or openrc",
        });
      }
      if (req.body?.confirm !== true) {
        return res.status(400).json({
          error: "Explicit lifecycle migration confirmation is required",
        });
      }

      const server = await getServer(serverId);
      if (!server) {
        return res.status(404).json({ error: "Server not found" });
      }
      const currentProvider = server.lifecycleProvider || "direct";
      if (provider === currentProvider) {
        return res.json({
          server: sanitizeServerResponse(server),
          message: `${provider} lifecycle is already active`,
        });
      }
      if (server.isRemote || server.dockerContainerName || server.dockerContainerId) {
        return res.status(409).json({
          error:
            "Remote and container-managed profiles must keep their existing lifecycle model",
        });
      }

      if (isManagedLifecycleProvider(provider)) {
        const lifecycle = createLinuxServiceLifecycle(server, provider);
        const preflight = await lifecycle.preflightActivation();
        if (!preflight.ready) {
          return res.status(409).json({
            error: sanitizeError(preflight.error),
            conflict: Boolean(preflight.conflict),
            running: Boolean(preflight.running),
          });
        }

        const directManager = new ServerManager();
        await directManager.reloadConfig(serverId);
        const directStatus = await directManager.getServerProcessDetails();
        if (directStatus.scanFailed) {
          return res.status(503).json({
            error:
              "Could not confirm that the directly managed server is stopped",
          });
        }
        if (directStatus.running) {
          return res.status(409).json({
            error:
              "Stop the directly managed server before activating a service provider. Running processes are never adopted automatically.",
            running: true,
          });
        }
      } else {
        const lifecycle = createLinuxServiceLifecycle(server, currentProvider);
        const currentStatus = await lifecycle.status();
        if (currentStatus.scanFailed || currentStatus.running) {
          return res.status(currentStatus.running ? 409 : 503).json({
            error: currentStatus.running
              ? "Stop the managed service before switching back to direct lifecycle"
              : "Could not confirm that the managed service is stopped",
            running: Boolean(currentStatus.running),
          });
        }
      }

      const updated = await updateServer(serverId, {
        lifecycleProvider: provider,
      });
      const sharedManager = req.app.get("serverManager");
      if (updated?.isActive && sharedManager?.reloadConfig) {
        await sharedManager.reloadConfig();
      }
      res.json({
        server: sanitizeServerResponse(updated),
        message: `Lifecycle provider changed to ${provider}`,
      });
    } catch (error) {
      log.error(`Failed to change lifecycle provider: ${error.message}`);
      res.status(400).json({ error: sanitizeError(error.message) });
    }
  },
);

router.post("/", requirePermission("servers.manage"), async (req, res) => {
  try {
    const config =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body
        : {};
    log.info(
      `POST / — creating server: name=${config?.name}, remote=${!!config?.isRemote}`,
    );

    if (config.importIniFrom && typeof config.importIniFrom === "object") {
      const allowed = await requireCapabilityInline("servers.discover", req, res);
      if (!allowed) return;

      const { dataPath: importDataPath, serverName: importServerName } =
        config.importIniFrom;
      if (
        typeof importDataPath !== "string" ||
        importDataPath.length > 500 ||
        !path.isAbsolute(importDataPath)
      ) {
        return res
          .status(400)
          .json({ error: "Invalid importIniFrom.dataPath" });
      }
      if (!isValidServerName(importServerName)) {
        return res
          .status(400)
          .json({ error: "Invalid importIniFrom.serverName" });
      }
      const resolvedImportData = path.resolve(importDataPath);
      const importServerConfigPath = path.join(resolvedImportData, "Server");
      if (!fs.existsSync(importServerConfigPath)) {
        return res.status(400).json({
          error: "Not a valid Zomboid data folder (no Server subfolder found)",
        });
      }
      const importIniPath = path.join(
        importServerConfigPath,
        `${importServerName}.ini`,
      );
      if (!fs.existsSync(importIniPath)) {
        return res
          .status(400)
          .json({ error: `${importServerName}.ini not found` });
      }
      let importedSettings;
      try {
        const importedContent = fs
          .readFileSync(importIniPath, "utf-8")
          .replace(/\r\n/g, "\n");
        importedSettings = parseIni(importedContent);
      } catch (err) {
        return res.status(400).json({
          error: `Failed to read ${importServerName}.ini: ${sanitizeError(err.message)}`,
        });
      }
      if (!importedSettings.RCONPassword) {
        return res.status(400).json({
          error: `RCON password not set in ${importServerName}.ini — set RCONPassword on the server, then retry.`,
        });
      }
      config.rconPassword = importedSettings.RCONPassword;
      if (!config.serverName) config.serverName = importServerName;
      config.zomboidDataPath = resolvedImportData;
    }

    if (!config.installPath)
      config.installPath = process.env.PZ_SERVER_PATH || "";
    if (!config.zomboidDataPath)
      config.zomboidDataPath = process.env.PZ_SAVE_PATH || null;

    if (config.isRemote !== undefined && typeof config.isRemote !== "boolean") {
      return res.status(400).json({ error: "isRemote must be a boolean" });
    }
    const isRemote = config.isRemote === true;
    const requiredFields = isRemote
      ? ["name", "rconHost", "rconPort", "rconPassword"]
      : ["name", "installPath", "rconHost", "rconPort", "rconPassword"];
    for (const field of requiredFields) {
      if (!config[field]) {
        return res
          .status(400)
          .json({ error: `Missing required field: ${field}` });
      }
    }

    if (!isRemote) {
      const installPathCheck = validateInstallPathShape(config.installPath);
      if (!installPathCheck.valid) {
        return res.status(400).json({ error: installPathCheck.error });
      }
    }

    if (typeof config.name !== "string" || config.name.length > 100) {
      return res
        .status(400)
        .json({ error: "Server name must be under 100 characters" });
    }

    const rconPort = parseBoundedInteger(config.rconPort, null, 1, 65535);
    if (rconPort === null) {
      return res.status(400).json({ error: "Invalid RCON port" });
    }
    if (
      typeof config.rconHost !== "string" ||
      !RCON_HOST_REGEX.test(config.rconHost.trim())
    ) {
      return res.status(400).json({ error: "Invalid RCON host" });
    }
    if (
      typeof config.rconPassword !== "string" ||
      config.rconPassword.length > RCON_PASSWORD_MAX_LENGTH
    ) {
      return res.status(400).json({ error: "Invalid RCON password" });
    }

    const serverName = String(config.serverName || config.name || "").trim();
    if (!isValidServerName(serverName)) {
      return res
        .status(400)
        .json({
          error: config.serverName
            ? "Invalid server name: only letters, numbers, underscores, hyphens and spaces allowed"
            : "Server name is required, or give the server a display name that can be reused as one (letters, numbers, underscores, hyphens and spaces only)",
        });
    }
    const dockerContainerName = String(config.dockerContainerName || "").trim();
    if (dockerContainerName && !isValidDockerContainerRef(dockerContainerName)) {
      return res.status(400).json({ error: "Invalid Docker container name" });
    }

    let serverPort = 16261;
    if (config.serverPort !== undefined && config.serverPort !== null && config.serverPort !== "") {
      serverPort = parseBoundedInteger(config.serverPort, null, 1, GAME_PORT_MAX);
      if (serverPort === null) {
        return res.status(400).json({ error: "Invalid server port" });
      }
    }

    for (const key of ["useNoSteam", "useDebug", "useUpnp"]) {
      if (config[key] !== undefined && typeof config[key] !== "boolean") {
        return res.status(400).json({ error: `${key} must be a boolean` });
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
      rconPort: rconPort,
      rconPassword: config.rconPassword,
      adminPassword: config.adminPassword || "",
      serverPort,
      minMemory: normalizeMemoryGb(config.minMemory, 4),
      maxMemory: normalizeMemoryGb(config.maxMemory, 8),
      useNoSteam: config.useNoSteam === true,
      useDebug: config.useDebug === true,
      useUpnp: config.useUpnp !== false,
      isRemote: isRemote,
    });

    log.info(`Created new server: ${server.name} (ID: ${server.id})`);
    res.status(201).json({
      server: sanitizeServerResponse(server),
      message: "Server created successfully",
    });
  } catch (error) {
    log.error(`Failed to create server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

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
  // Was absent from this list entirely (2026-08-26 same pass audit) --
  // there was no edit-screen path to fix a missing/wrong UPnP setting the
  // way adminPassword had one, because there was no per-server column for
  // it to update in the first place.
  "useUpnp",
  "isRemote",
  "startCommand",
  "adminPassword",
  // startBat/batFile used to be allowed here too. Re-confirmed dead
  // (2026-08-27, custom-launcher-as-a-real-supported-mode-not-an-accident):
  // grepped apps/panel-server/services/serverManager.js, apps/panel-server/database/init.js,
  // and all of apps/panel-client/src --
  // zero reads of either field anywhere. Removed rather than repurposed:
  // the real, now-supported mechanism for "point at a specific launcher
  // file" is a serverPath/installPath ending in .bat/.sh/.exe (see
  // resolveLaunchMode()), and keeping these next to that would have been a
  // third, unused mechanism sitting beside the two real ones.
  //
  // "description" removed the same way (2026-08-29): grepped for
  // `.description` on a server-shaped object across apps/panel-server/ and apps/panel-client/src/
  // -- every hit was mod metadata, Steam branch metadata, a toast's
  // `description` field, or an i18n key literally named `description`, none
  // of it this record's own field. updateServer() persists whatever lands in
  // `updates` via `{...db.data.servers[index], ...updates}` -- a spread, not
  // a field-by-field write -- so the value WAS being written to db.json on
  // every update that included it, just never read back by anything. A
  // request that still sends "description" after this change has it
  // silently filtered out here (same as any other field never on this
  // list) -- not a 400, just ignored, matching how startBat/batFile already
  // behave.
];

export function parseServerId(value) {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return /^\d+$/.test(id) ? Number(id) : id;
}

router.put("/:id", requirePermission("servers.manage"), async (req, res) => {
  const lifecycleLock = acquireLifecycleLock(
    "server-profile-change",
    req.params.id || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: "Invalid server ID" });
    }
    const serverId = parseServerId(id);
    if (serverId === null) {
      return res.status(400).json({ error: "Invalid server ID" });
    }

    const updates = {};
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body
        : {};
    for (const key of ALLOWED_SERVER_UPDATE_FIELDS) {
      if (body[key] !== undefined) {
        updates[key] = body[key];
      }
    }

    if (updates.serverName !== undefined) {
      if (typeof updates.serverName !== "string") {
        return res.status(400).json({ error: "Invalid server name" });
      }
      const trimmed = updates.serverName.trim();
      if (!isValidServerName(trimmed)) {
        return res.status(400).json({
          error:
            "Invalid server name: only letters, numbers, underscores, hyphens and spaces allowed",
        });
      }
      updates.serverName = trimmed;
    }

    if (
      updates.name !== undefined &&
      (typeof updates.name !== "string" || updates.name.length > 100)
    ) {
      return res.status(400).json({
        error: "Server name must be under 100 characters",
      });
    }

    if (updates.dockerContainerName !== undefined) {
      if (
        updates.dockerContainerName !== null &&
        typeof updates.dockerContainerName !== "string"
      ) {
        return res.status(400).json({
          error: "Invalid Docker container name",
        });
      }
      const value = (updates.dockerContainerName || "").trim();
      if (value && !isValidDockerContainerRef(value)) {
        return res.status(400).json({
          error: "Invalid Docker container name",
        });
      }
      updates.dockerContainerName = value || null;
    }

    for (const key of ["installPath", "serverPath"]) {
      if (updates[key] !== undefined && updates[key] !== "") {
        const check = validateInstallPathShape(updates[key]);
        if (!check.valid) {
          return res.status(400).json({ error: check.error });
        }
      }
    }

    if (updates.zomboidDataPath !== undefined && updates.zomboidDataPath !== "") {
      const effectiveIsRemote =
        updates.isRemote !== undefined
          ? updates.isRemote
          : Boolean((await getServer(serverId))?.isRemote);
      if (!effectiveIsRemote) {
        const normalized = normalizeUserPath(updates.zomboidDataPath);
        const resolved = normalized ? path.resolve(normalized) : null;
        if (!resolved || !fs.existsSync(resolved)) {
          return res.status(400).json({
            error: `Zomboid data path does not exist: ${resolved || updates.zomboidDataPath}. Check for typos and verify the panel has read access to this folder.`,
          });
        }
        let isDir = false;
        try {
          isDir = fs.statSync(resolved).isDirectory();
        } catch {
          isDir = false;
        }
        if (!isDir) {
          return res.status(400).json({
            error: `Zomboid data path is not a directory: ${resolved}`,
          });
        }
        const verdict = inspectZomboidPath(resolved);
        if (!verdict.ok) {
          return res.status(400).json({
            error:
              verdict.reason === "install-folder"
                ? "This folder looks like a Project Zomboid server install, not a user data folder. Point at the Zomboid user data folder instead."
                : "This doesn't look like a Project Zomboid data folder (no Saves/Multiplayer directory or save files found there).",
          });
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
        return res.status(400).json({ error: "Invalid RCON host" });
      }
      updates.rconHost = updates.rconHost.trim();
    }

    if (
      updates.rconPassword !== undefined &&
      (typeof updates.rconPassword !== "string" ||
        updates.rconPassword.length > RCON_PASSWORD_MAX_LENGTH)
    ) {
      return res.status(400).json({ error: "Invalid RCON password" });
    }

    if (updates.rconPort !== undefined) {
      const rconPort = parseBoundedInteger(updates.rconPort, null, 1, 65535);
      if (rconPort === null) {
        return res.status(400).json({ error: "Invalid RCON port" });
      }
      updates.rconPort = rconPort;
    }

    if (updates.serverPort !== undefined) {
      const serverPort = parseBoundedInteger(updates.serverPort, null, 1, GAME_PORT_MAX);
      if (serverPort === null) {
        return res.status(400).json({ error: "Invalid server port" });
      }
      updates.serverPort = serverPort;
    }

    if (updates.minMemory !== undefined) {
      updates.minMemory = normalizeMemoryGb(updates.minMemory, 4);
    }
    if (updates.maxMemory !== undefined) {
      updates.maxMemory = normalizeMemoryGb(updates.maxMemory, 8);
    }

    for (const key of ["useNoSteam", "useDebug", "isRemote", "useUpnp"]) {
      if (updates[key] !== undefined) {
        if (typeof updates[key] !== "boolean") {
          return res.status(400).json({ error: `${key} must be a boolean` });
        }
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
      return res.status(400).json({ error: "At least one field is required" });
    }

    const server = await updateServer(serverId, updates);
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    log.info(`Updated server: ${server.name} (ID: ${server.id})`);

    const reloadWarnings = [];
    if (server.isActive) {
      const rconFieldsChanged = ["rconHost", "rconPort", "rconPassword"].some(
        (k) => Object.prototype.hasOwnProperty.call(updates, k),
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
      ].some((k) => Object.prototype.hasOwnProperty.call(updates, k));

      const rconService = req.app.get("rconService");
      const serverManager = req.app.get("serverManager");

      if (serverManagerFieldsChanged && serverManager?.reloadConfig) {
        try {
          await serverManager.reloadConfig();
          log.info(`ServerManager config refreshed after active server update`);
        } catch (e) {
          log.warn(`ServerManager reload failed after update: ${e.message}`);
          reloadWarnings.push(
            "Server manager failed to reload; restart the panel or server before relying on the updated settings",
          );
        }
      }

      if (rconFieldsChanged && rconService?.reloadConfig) {
        try {
          if (rconService.isConnected && rconService.isConnected()) {
            await rconService.disconnect();
          }
          await rconService.reloadConfig();
          const reconnected = await rconService.connect();
          if (!reconnected) {
            log.warn("RCON reconnect returned false after active server update");
            reloadWarnings.push(
              "RCON could not reconnect; verify the updated connection settings",
            );
          } else {
            log.info(`RCON config refreshed after active server update`);
          }
        } catch (e) {
          log.warn(`RCON reload failed after update: ${e.message}`);
          reloadWarnings.push(
            "RCON failed to reload; reconnect before relying on the updated connection settings",
          );
        }
      }

      if (Object.prototype.hasOwnProperty.call(updates, "installPath")) {
        await refreshWorkshopCheckerIfAvailable(req);
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

    res.json({
      server: sanitizeServerResponse(server),
      message: "Server updated successfully",
      ...(reloadWarnings.length > 0 ? { warnings: reloadWarnings } : {}),
    });
  } catch (error) {
    log.error(`Failed to update server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    lifecycleLock.release();
  }
});

router.delete("/:id", requirePermission("servers.manage"), async (req, res) => {
  const lifecycleLock = acquireLifecycleLock(
    "server-profile-change",
    req.params.id || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: "Invalid server ID" });
    }
    const serverId = parseServerId(id);
    if (serverId === null) {
      return res.status(400).json({ error: "Invalid server ID" });
    }

    const targetServer = await getServer(serverId);
    const deletingActiveServer = !!targetServer?.isActive;

    const success = await deleteServer(serverId);
    if (!success) {
      return res.status(404).json({ error: "Server not found" });
    }

    const io = req.app.get("io");

    if (deletingActiveServer) {
      const newActiveServer = await getActiveServer();
      if (newActiveServer) {
        try {
          await reloadServicesForNewActiveServer(req, newActiveServer);
        } catch (reloadErr) {
          log.warn(
            `Failed to reload services after deleting the active server: ${reloadErr.message}`,
          );
        }
        if (io) {
          io.emit("activeServerChanged", { server: sanitizeServerResponse(newActiveServer) });
        }
      } else if (io) {
        io.emit("activeServerChanged", { deleted: serverId });
      }
    } else if (io) {
      io.emit("activeServerChanged", { deleted: serverId });
    }

    log.info(`Deleted server ID: ${serverId}`);
    res.json({ success: true, message: "Server deleted successfully" });
  } catch (error) {
    log.error(`Failed to delete server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    lifecycleLock.release();
  }
});

async function reloadServicesForNewActiveServer(req, server) {
  const rconService = req.app.get("rconService");
  const serverManager = req.app.get("serverManager");

  if (serverManager && serverManager.reloadConfig) {
    await serverManager.reloadConfig();
    log.info(`ServerManager reloaded config for server: ${server.name}`);
  }

  await refreshWorkshopCheckerIfAvailable(req);

  if (rconService && rconService.isConnected()) {
    await rconService.disconnect();
  }

  if (rconService && server.rconPassword) {
    try {
      await rconService.reloadConfig();
      await rconService.connect();
      log.info(`RCON reconnected for server: ${server.name}`);
    } catch (rconErr) {
      log.warn(`Failed to connect RCON for new server: ${rconErr.message}`);
    }
  }

  autoInstallBridgeIfNeeded(server);
}

router.post("/:id/activate", requirePermission("servers.manage"), async (req, res) => {
  const lifecycleLock = acquireLifecycleLock(
    "server-profile-change",
    req.params.id || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: "Invalid server ID" });
    }
    const serverId = parseServerId(id);
    if (serverId === null) {
      return res.status(400).json({ error: "Invalid server ID" });
    }

    const server = await setActiveServer(serverId);
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    const io = req.app.get("io");
    const reloadWarnings = [];
    try {
      await reloadServicesForNewActiveServer(req, server);
    } catch (reloadErr) {
      log.warn(
        `Failed to reload services after activating server: ${reloadErr.message}`,
      );
      reloadWarnings.push(
        "Server activated, but live services could not be fully reloaded; restart the panel or reconnect RCON before relying on the new settings",
      );
    }

    if (io) {
      io.emit("activeServerChanged", { server: sanitizeServerResponse(server) });
    }

    log.info(`Activated server: ${server.name} (ID: ${server.id})`);
    res.json({
      server: sanitizeServerResponse(server),
      message: `Now managing: ${server.name}`,
      ...(reloadWarnings.length > 0 ? { warnings: reloadWarnings } : {}),
    });
  } catch (error) {
    log.error(`Failed to activate server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    lifecycleLock.release();
  }
});

export default router;
