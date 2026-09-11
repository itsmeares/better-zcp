import { Router, type NextFunction, type Request, type Response } from "../http/startApiRouter.ts";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.ts";
const log = createLogger("API:Servers");
import {
  sanitizeError,
  sanitizeServerResponse,
  sanitizeServerResponseList,
} from "../utils/sanitize.ts";
import { testRconConnection } from "../services/rcon.ts";
import {
  getServers,
  getServer,
  getActiveServer,
  getAllSettings,
} from "../database/init.ts";
import { isRemoteConfigConfigured } from "../services/remoteConfigFiles.ts";
import { normalizeUserPath, inspectZomboidPath } from "../utils/zomboidPaths.ts";
import { requirePermission } from "../services/permissions.ts";
import {
  parseBoundedInteger,
  parseClampedInteger,
} from "../utils/queryNumbers.ts";
import { GAME_PORT_MAX } from "./server.ts";
import {
  createLinuxServiceLifecycle,
  getLinuxLifecycleCapabilities,
  isManagedLifecycleProvider,
} from "../services/linuxServiceLifecycle.ts";
import {
  activateLifecycleProvider,
  activateServerProfile,
  createServerProfile,
  deleteServerProfile,
  getLifecycleTemplateForServer,
  parseServerId,
  ServerProfileError,
  updateServerProfile,
} from "../services/serverProfiles.ts";

const router = Router();

type JsonRecord = Record<string, any>;
type ScanResults = {
  installPaths: string[];
  dataPaths: string[];
  customBatFiles: Array<{
    path: string;
    folder: string;
    fileName: string;
    serverName: string;
  }>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requireCapabilityInline(
  capability: string,
  req: Request,
  res: Response,
): Promise<boolean> {
  let passed = false;
  await requirePermission(capability)(req, res, (() => {
    passed = true;
  }) as NextFunction);
  return passed;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R> | R,
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

function profileRuntime(req: Request) {
  const get = (key: string) => req.app?.get?.(key);
  return {
    rconService: get("rconService"),
    serverManager: get("serverManager"),
    modChecker: get("modChecker"),
    logTailer: get("logTailer"),
    io: get("io"),
    refreshWorkshopChecker: get("refreshWorkshopChecker"),
    autoInstallBridgeIfNeeded: get("autoInstallBridgeIfNeeded"),
  };
}

function sendProfileError(error: unknown, res: Response): boolean {
  if (!(error instanceof ServerProfileError)) return false;
  res.status(error.status).json({
    error: sanitizeError(error.message),
    ...(error.code ? { code: error.code } : {}),
    ...(error.details ?? {}),
  });
  return true;
}

export { parseServerId };

function parseIni(content: string): Record<string, string> {
  const result: Record<string, string> = {};
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

export function parseDiscoveredPort(
  value: unknown,
  fallback: number,
  max = 65535,
): number | null {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") return null;
  if (value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) return null;
  return parseBoundedInteger(value, null, 1, max);
}

function scanForPzPaths(rootPath: string, maxDepth = 3): ScanResults {
  const results: ScanResults = {
    installPaths: [], // Folders containing PZ server startup scripts
    dataPaths: [], // Folders containing Server/ subfolder with .ini files
    customBatFiles: [], // Custom startup scripts found
  };

  function scan(currentPath: string, depth: number): void {
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
        } catch (e: unknown) {
          log.debug(`Skipping inaccessible path ${itemPath}: ${errorMessage(e)}`);
        }
      }
    } catch (e: unknown) {
      log.debug(`Skipping inaccessible folder ${currentPath}: ${errorMessage(e)}`);
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
        } catch (err: unknown) {
          log.warn(`Failed to parse ${iniFile}: ${errorMessage(err)}`);
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
  } catch (error: unknown) {
    log.error(`Failed to auto-scan: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
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
        } catch (err: unknown) {
          log.warn(`Failed to parse ${iniFile}: ${errorMessage(err)}`);
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
  } catch (error: unknown) {
    log.error(`Failed to detect server: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

function computeRemoteConfigConfigured(
  server: JsonRecord,
  settings: JsonRecord,
): boolean {
  return server.isRemote ? isRemoteConfigConfigured(settings) : false;
}

router.get("/", async (req, res) => {
  try {
    const servers = (await getServers()) as JsonRecord[];
    const settings = (await getAllSettings()) as JsonRecord;
    const withRemoteConfig = servers.map((server: JsonRecord) => ({
      ...server,
      remoteConfigConfigured: computeRemoteConfigConfigured(server, settings),
    }));
    res.json({
      servers: sanitizeServerResponseList(withRemoteConfig),
      lifecycleCapabilities: getLinuxLifecycleCapabilities(),
    });
  } catch (error: unknown) {
    log.error(`Failed to get servers: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/status", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const servers = (await getServers()) as JsonRecord[];
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
      } catch (err: unknown) {
        detectionError = errorMessage(err);
        log.debug(`Per-server status detection failed: ${errorMessage(err)}`);
      }
    }

    const norm = (p: unknown): string =>
      String(p || "")
        .toLowerCase()
        .replace(/\\/g, "/")
        .trim();

    const statuses = await Promise.all(servers.map(async (server: JsonRecord) => {
      if (isManagedLifecycleProvider(server.lifecycleProvider)) {
        try {
          const status = await createLinuxServiceLifecycle(
            server as Parameters<typeof createLinuxServiceLifecycle>[0],
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
        } catch (error: unknown) {
          return {
            id: server.id,
            name: server.name,
            running: false,
            pid: null,
            isActive: server.id === activeId,
            provider: server.lifecycleProvider,
            stateUnknown: true,
            error: sanitizeError(errorMessage(error)),
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
  } catch (error: unknown) {
    log.error(`Failed to get per-server status: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/rcon-status", async (req, res) => {
  try {
    const servers = (await getServers()) as JsonRecord[];
    const statuses = await mapWithConcurrency(servers, 3, async (server: JsonRecord) => {
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
  } catch (error: unknown) {
    log.error(`Failed to probe server RCON status: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
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
  } catch (error: unknown) {
    log.error(`Failed to get active server: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
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
  } catch (error: unknown) {
    log.error(`Failed to get server: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get(
  "/:id/lifecycle-template",
  requirePermission("servers.manage"),
  async (req, res) => {
    try {
      const template = await getLifecycleTemplateForServer(
        req.params.id,
        req.query?.provider,
        req.query?.serviceUser,
      );
      res.json(template);
    } catch (error: unknown) {
      if (sendProfileError(error, res)) return;
      log.error(
        `Failed to generate lifecycle template: ${errorMessage(error)}`,
      );
      res.status(400).json({ error: sanitizeError(errorMessage(error)) });
    }
  },
);

router.post(
  "/:id/lifecycle-provider",
  requirePermission("servers.manage"),
  async (req, res) => {
    try {
      const result = await activateLifecycleProvider(
        req.params.id,
        req.body?.provider,
        req.body?.confirm,
        profileRuntime(req),
      );
      res.json({
        ...result,
        server: sanitizeServerResponse(result.server),
      });
    } catch (error: unknown) {
      if (sendProfileError(error, res)) return;
      log.error(`Failed to change lifecycle provider: ${errorMessage(error)}`);
      res.status(400).json({ error: sanitizeError(errorMessage(error)) });
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
      `POST / — creating server: name=${config.name}, remote=${!!config.isRemote}`,
    );

    let allowIniImport = false;
    if (config.importIniFrom && typeof config.importIniFrom === "object") {
      allowIniImport = await requireCapabilityInline(
        "servers.discover",
        req,
        res,
      );
      if (!allowIniImport) return;
    }

    const server = await createServerProfile(config, { allowIniImport });
    res.status(201).json({
      server: sanitizeServerResponse(server),
      message: "Server created successfully",
    });
  } catch (error: unknown) {
    if (sendProfileError(error, res)) return;
    log.error(`Failed to create server: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.put("/:id", requirePermission("servers.manage"), async (req, res) => {
  try {
    const result = await updateServerProfile(
      req.params.id,
      req.body,
      profileRuntime(req),
    );
    res.json({
      ...result,
      server: sanitizeServerResponse(result.server),
    });
  } catch (error: unknown) {
    if (sendProfileError(error, res)) return;
    log.error(`Failed to update server: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.delete("/:id", requirePermission("servers.manage"), async (req, res) => {
  try {
    res.json(await deleteServerProfile(req.params.id, profileRuntime(req)));
  } catch (error: unknown) {
    if (sendProfileError(error, res)) return;
    log.error(`Failed to delete server: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post(
  "/:id/activate",
  requirePermission("servers.manage"),
  async (req, res) => {
    try {
      const result = await activateServerProfile(
        req.params.id,
        profileRuntime(req),
      );
      res.json({
        ...result,
        server: sanitizeServerResponse(result.server),
      });
    } catch (error: unknown) {
      if (sendProfileError(error, res)) return;
      log.error(`Failed to activate server: ${errorMessage(error)}`);
      res.status(500).json({ error: sanitizeError(errorMessage(error)) });
    }
  },
);

export default router;
