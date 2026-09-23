import { Router } from "../http/startApiRouter.ts";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import bridge from "../services/panelBridge.ts";
import {
  getActiveServer,
  getServer,
  getServers,
  setSetting,
  getDb,
  commitNow,
  logBridgeCommand,
} from "../database/init.ts";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.ts";
import { persistSandboxValues } from "../services/sandboxPersistence.ts";
import { parseClampedInteger } from "../utils/queryNumbers.ts";
import {
  getEmbeddedPanelBridgeLua,
  compareModVersions,
  writeLuaAtomic,
} from "../utils/embeddedLua.ts";
import {
  canAutoInstall,
  checkBridgeInstalled,
  getBundledBridgeVersion,
  installBridge,
  isBridgeVersionBehindBundled,
  resolveInstallDir,
} from "../services/panelBridgeInstaller.ts";
import { createLogger } from "../utils/logger.ts";
import {
  VALID_ACTIONS,
} from "../services/panelBridgePolicy.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import {
  PANEL_BRIDGE_COMMANDS,
} from "../services/panelBridgeCommands.ts";
export { VALID_ACTIONS } from "../services/panelBridgePolicy.ts";
const log = createLogger("API:PanelBridge");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();
type AnyRecord = Record<string, any>;
type BridgePath = {
  path: string;
  source: string;
  hasStatus: boolean;
  hasInit: boolean;
  exists: boolean;
  priority: number;
};

const BRIDGE_USERNAME_REGEX = /^(?=.*\S)[^\x00-\x1F\x7F"\\]{1,64}$/;

const BLOCKED_BRIDGE_PATH_PREFIXES =
  process.platform === "win32"
    ? ["c:\\windows", "c:\\program files"]
    : ["/etc", "/usr", "/bin", "/sbin", "/proc", "/sys", "/dev"];

function isValidBridgePath(inputPath: any) {
  if (!inputPath || typeof inputPath !== "string") return false;
  if (!path.isAbsolute(inputPath)) return false;
  const resolved = path.resolve(inputPath);
  const lower =
    process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return !BLOCKED_BRIDGE_PATH_PREFIXES.some((p) => lower.startsWith(p));
}

router.get("/status", async (req, res) => {
  const status = bridge.getStatus() as AnyRecord;

  let detectedPaths: AnyRecord | null = null;
  let localInstall: AnyRecord | null = null;
  try {
    const activeServer = await getActiveServer();
    if (activeServer) {
      detectedPaths = {
        serverName: activeServer.serverName || activeServer.name,
        installPath: activeServer.installPath,
        zomboidDataPath: activeServer.zomboidDataPath,
        // Bridge path would be: zomboidDataPath/Saves/Multiplayer/{serverName}/panelbridge/
        // OR for dedicated servers: installPath/../Server_files/Saves/Multiplayer/{serverName}/panelbridge/
      };
      localInstall = {
        canAutoInstall: canAutoInstall(activeServer),
        ...checkBridgeInstalled(activeServer),
      };
    }
  } catch (e: any) {
    // Ignore
  }

  res.json({
    ...status,
    modConnected: bridge.isModConnected(),
    detectedPaths,
    localInstall,
  });
});

router.post("/auto-configure", async (req, res) => {
  try {
    const { serverId } = req.body || {};
    log.info(`POST /auto-configure (serverId=${serverId || "active"})`);

    let targetServer;
    if (serverId) {
      targetServer = await getServer(serverId);
      if (!targetServer) {
        return res.status(400).json({
          error: `Server with ID ${serverId} not found.`,
          code: ErrorCode.PANELBRIDGE_SERVER_ID_NOT_FOUND,
          params: sanitizeErrorParams({ serverId }),
        });
      }
    } else {
      targetServer = await getActiveServer();
      if (!targetServer) {
        return res.status(400).json({
          error:
            "No active server configured. Please configure a server first.",
          code: ErrorCode.PANELBRIDGE_AUTO_CONFIGURE_NO_ACTIVE_SERVER,
        });
      }
    }

    const serverName = targetServer.serverName || targetServer.name;
    if (!serverName) {
      return res.status(400).json({
        error: "Server name not configured.",
        code: ErrorCode.PANELBRIDGE_SERVER_NAME_NOT_CONFIGURED,
      });
    }

    const possiblePaths: BridgePath[] = [];
    const searchedLocations: AnyRecord[] = [];

    const safeReadDir = (dirPath: string): string[] => {
      try {
        return fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : [];
      } catch (e: any) {
        return [];
      }
    };

    const addPath = (p: string, source: string, priority = 10) => {
      if (possiblePaths.some((pp) => pp.path === p)) return;

      const statusFile = path.join(p, "status.json");
      const initFile = path.join(p, ".init");
      const hasStatus = fs.existsSync(statusFile);
      const hasInit = fs.existsSync(initFile);

      possiblePaths.push({
        path: p,
        source,
        hasStatus,
        hasInit,
        exists: hasStatus || hasInit || fs.existsSync(p),
        priority,
      });
      searchedLocations.push({ path: p, source, hasStatus, hasInit });
    };

    if (targetServer.zomboidDataPath) {
      addPath(
        path.join(
          targetServer.zomboidDataPath,
          "Lua",
          "panelbridge",
          serverName,
        ),
        "zomboidDataPath/Lua (cachedir)",
        1,
      );
    }

    addPath(
      path.join(os.homedir(), "Zomboid", "Lua", "panelbridge", serverName),
      "default Zomboid folder",
      2,
    );

    if (targetServer.installPath) {
      const parentDir = path.dirname(targetServer.installPath);
      const parentContents = safeReadDir(parentDir);
      for (const item of parentContents) {
        if (item.startsWith("Server_files") || item.match(/Server.*files/i)) {
          const luaPath = path.join(
            parentDir,
            item,
            "Lua",
            "panelbridge",
            serverName,
          );
          addPath(luaPath, `${item}/Lua`, 3);
        }
      }

      const grandParentDir = path.dirname(parentDir);
      if (grandParentDir !== parentDir) {
        const grandParentContents = safeReadDir(grandParentDir);
        for (const item of grandParentContents) {
          if (item.startsWith("Server_files") || item.match(/Server.*files/i)) {
            const luaPath = path.join(
              grandParentDir,
              item,
              "Lua",
              "panelbridge",
              serverName,
            );
            addPath(luaPath, `${item}/Lua`, 4);
          }
        }
      }

      addPath(
        path.join(targetServer.installPath, "Lua", "panelbridge", serverName),
        "installPath/Lua",
        5,
      );
    }

    possiblePaths.sort((a, b) => {
      if (a.hasStatus && !b.hasStatus) return -1;
      if (!a.hasStatus && b.hasStatus) return 1;
      if (a.hasInit && !b.hasInit) return -1;
      if (!a.hasInit && b.hasInit) return 1;
      return a.priority - b.priority;
    });

    let foundPath = possiblePaths.find((p) => p.hasStatus);

    if (!foundPath) {
      foundPath = possiblePaths.find((p) => p.hasInit);
    }

    if (!foundPath) {
      foundPath = possiblePaths.find((p) => p.exists);
    }

    if (!foundPath && possiblePaths.length > 0) {
      possiblePaths.sort((a, b) => a.priority - b.priority);
      foundPath = possiblePaths[0];
    }

    if (!foundPath) {
      return res.status(400).json({
        error: `Could not determine bridge path for server "${serverName}". Make sure server installPath is set.`,
        code: ErrorCode.PANELBRIDGE_PATH_NOT_DETERMINED,
        searchedPaths: searchedLocations,
      });
    }

    if (bridge.isRunning) {
      bridge.stop();
    }

    bridge.configure(foundPath.path, true);
    bridge.start();

    let modInstalled = false;
    let modUpdated = false;
    try {
      const installDir = resolveInstallDir(targetServer);
      if (installDir) {
        const destLuaFile = path.join(
          installDir,
          "media",
          "lua",
          "server",
          "PanelBridge.lua",
        );

        let srcContent = getEmbeddedPanelBridgeLua();

        if (!srcContent) {
          const possibleModPaths = [
            path.join(
              __dirname,
              "..",
              "..",
              "..",
              "integrations",
              "panelbridge",
              "PanelBridge",
            ),
            path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
          ];
          for (const modPath of possibleModPaths) {
            const candidate = path.join(
              modPath,
              "media",
              "lua",
              "server",
              "PanelBridge.lua",
            );
            if (fs.existsSync(candidate)) {
              srcContent = fs.readFileSync(candidate, "utf8");
              break;
            }
          }
        }

        if (srcContent) {
          let needsCopy = !fs.existsSync(destLuaFile);

          if (!needsCopy) {
            modInstalled = true;
            try {
              const destContent = fs.readFileSync(destLuaFile, "utf8");
              const srcVersion = (srcContent.match(/VERSION\s*=\s*"([^"]+)"/) ||
                [])[1];
              const destVersion = (destContent.match(
                /VERSION\s*=\s*"([^"]+)"/,
              ) || [])[1];
              if (
                srcVersion &&
                destVersion &&
                compareModVersions(srcVersion, destVersion) > 0
              ) {
                needsCopy = true;
                modUpdated = true;
                log.info(
                  `PanelBridge mod update: ${destVersion} → ${srcVersion}`,
                );
              }
            } catch (_: any) {
              /* ignore read errors — keep existing */
            }
          }

          if (needsCopy) {
            writeLuaAtomic(destLuaFile, srcContent);
            modInstalled = true;
            if (modUpdated) {
              log.info("PanelBridge mod updated on server");
            } else {
              log.info("PanelBridge mod auto-installed to server");
            }
          }
        }
      }
    } catch (modError: any) {
      log.warn(`Auto-install mod failed: ${modError.message}`);
    }

    res.json({
      success: true,
      message: `Bridge auto-configured from server: ${targetServer.name}`,
      bridgePath: foundPath.path,
      serverName,
      source: foundPath.source,
      hasStatus: foundPath.hasStatus,
      modInstalled,
      modUpdated,
      searchedPaths: searchedLocations,
    });
    log.info(
      `Bridge auto-configured: path=${foundPath.path} source=${foundPath.source} hasStatus=${foundPath.hasStatus} modInstalled=${modInstalled}`,
    );
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/scan-server/:serverId", async (req, res) => {
  try {
    const { serverId } = req.params;
    const targetServer = await getServer(serverId);

    if (!targetServer) {
      return res.status(404).json({
        success: false,
        error: `Server with ID ${serverId} not found.`,
        code: ErrorCode.PANELBRIDGE_SERVER_ID_NOT_FOUND,
        params: sanitizeErrorParams({ serverId }),
      });
    }

    const serverName = targetServer.serverName || targetServer.name;
    if (!serverName) {
      return res.status(400).json({
          success: false,
          error: "Server name not configured.",
          code: ErrorCode.PANELBRIDGE_SERVER_NAME_NOT_CONFIGURED,
        });
    }

    const possiblePaths: BridgePath[] = [];

    const safeReadDir = (dirPath: string): string[] => {
      try {
        return fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : [];
      } catch (e: any) {
        return [];
      }
    };

    const addPath = (p: string, source: string, priority = 10) => {
      if (possiblePaths.some((pp) => pp.path === p)) return;

      const statusFile = path.join(p, "status.json");
      const initFile = path.join(p, ".init");
      const hasStatus = fs.existsSync(statusFile);
      const hasInit = fs.existsSync(initFile);

      possiblePaths.push({
        path: p,
        source,
        hasStatus,
        hasInit,
        exists: hasStatus || hasInit || fs.existsSync(p),
        priority,
      });
    };

    const defaultZomboidPath = path.join(
      os.homedir(),
      "Zomboid",
      "Lua",
      "panelbridge",
      serverName,
    );
    addPath(defaultZomboidPath, "default Zomboid folder", 0);

    if (targetServer.installPath) {
      const parentDir = path.dirname(targetServer.installPath);

      const parentContents = safeReadDir(parentDir);
      for (const item of parentContents) {
        if (item.startsWith("Server_files") || item.match(/Server.*files/i)) {
          const luaPath = path.join(
            parentDir,
            item,
            "Lua",
            "panelbridge",
            serverName,
          );
          addPath(luaPath, `${item}`, 1);
        }
      }

      const grandParentDir = path.dirname(parentDir);
      if (grandParentDir !== parentDir) {
        const grandParentContents = safeReadDir(grandParentDir);
        for (const item of grandParentContents) {
          if (item.startsWith("Server_files") || item.match(/Server.*files/i)) {
            const luaPath = path.join(
              grandParentDir,
              item,
              "Lua",
              "panelbridge",
              serverName,
            );
            addPath(luaPath, `${item} (grandparent)`, 2);
          }
        }
      }

      addPath(
        path.join(targetServer.installPath, "Lua", "panelbridge", serverName),
        "installPath/Lua",
        3,
      );
      addPath(
        path.join(parentDir, "Lua", "panelbridge", serverName),
        "parent/Lua",
        4,
      );
    }

    if (targetServer.zomboidDataPath) {
      addPath(
        path.join(
          targetServer.zomboidDataPath,
          "Lua",
          "panelbridge",
          serverName,
        ),
        "zomboidDataPath",
        1,
      );
    }

    possiblePaths.sort((a, b) => {
      if (a.hasStatus && !b.hasStatus) return -1;
      if (!a.hasStatus && b.hasStatus) return 1;
      if (a.hasInit && !b.hasInit) return -1;
      if (!a.hasInit && b.hasInit) return 1;
      return a.priority - b.priority;
    });

    const recommendedPath =
      possiblePaths.find((p) => p.hasStatus) ||
      possiblePaths.find((p) => p.hasInit) ||
      possiblePaths[0] ||
      null;

    res.json({
      success: true,
      serverName,
      serverId: targetServer.id,
      paths: possiblePaths,
      recommendedPath: recommendedPath?.path || null,
      recommendedSource: recommendedPath?.source || null,
    });
  } catch (error: any) {
    res
      .status(500)
      .json({ success: false, error: sanitizeError(error.message) });
  }
});

router.post("/auto-detect", async (req, res) => {
  const { serverName, zomboidUserFolder } = req.body || {};

  if (!serverName) {
    return res.status(400).json({
      error: "serverName is required",
      code: ErrorCode.PANELBRIDGE_SERVER_NAME_REQUIRED,
    });
  }

  if (zomboidUserFolder && !isValidBridgePath(zomboidUserFolder)) {
    return res.status(400).json({
      error: "Invalid zomboidUserFolder path",
      code: ErrorCode.PANELBRIDGE_INVALID_ZOMBOID_USER_FOLDER,
    });
  }

  try {
    if (bridge.isRunning) {
      bridge.stop();
    }
    const bridgePath = bridge.autoDetect(serverName, zomboidUserFolder);
    bridge.start();
    res.json({
      success: true,
      message: "Bridge auto-configured and started",
      bridgePath,
    });
  } catch (error: any) {
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

router.post("/configure", async (req, res) => {
  const { zomboidSavePath } = req.body || {};

  if (!zomboidSavePath) {
    return res.status(400).json({
      error: "zomboidSavePath is required",
      code: ErrorCode.PANELBRIDGE_SAVE_PATH_REQUIRED,
    });
  }

  if (!isValidBridgePath(zomboidSavePath)) {
    return res.status(400).json({
      error: "Invalid zomboidSavePath",
      code: ErrorCode.PANELBRIDGE_INVALID_SAVE_PATH,
    });
  }

  try {
    if (bridge.isRunning) {
      bridge.stop();
    }
    const bridgePath = bridge.configure(zomboidSavePath);
    bridge.start();
    await setSetting("panelBridge", { bridgePath });
    res.json({
      success: true,
      message: "Bridge configured and started",
      bridgePath,
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/configure-direct", async (req, res) => {
  const { bridgePath: reqPath } = req.body || {};

  if (!reqPath || typeof reqPath !== "string") {
    return res.status(400).json({
      error: "bridgePath is required",
      code: ErrorCode.PANELBRIDGE_BRIDGE_PATH_REQUIRED,
    });
  }

  if (!path.isAbsolute(reqPath)) {
    return res.status(400).json({
      error: "Path must be absolute",
      code: ErrorCode.PANELBRIDGE_PATH_MUST_BE_ABSOLUTE,
    });
  }
  const resolved = path.resolve(reqPath);

  const lower =
    process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (BLOCKED_BRIDGE_PATH_PREFIXES.some((p) => lower.startsWith(p))) {
    return res.status(400).json({
      error: "Path targets a protected system directory",
      code: ErrorCode.PANELBRIDGE_PATH_PROTECTED_SYSTEM_DIR,
    });
  }

  try {
    if (bridge.isRunning) {
      bridge.stop();
    }
    const configuredPath = bridge.configure(resolved, true);
    bridge.start();
    await setSetting("panelBridge", { bridgePath: configuredPath });
    res.json({
      success: true,
      message: "Bridge configured with manual path and started",
      bridgePath: configuredPath,
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/start", (req, res) => {
  try {
    bridge.start();
    res.json({ success: true, message: "Bridge started" });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/stop", (req, res) => {
  try {
    bridge.stop();
    res.json({ success: true, message: "Bridge stopped" });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/scan-paths", async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    const foundBridges: AnyRecord[] = [];
    const scannedDirs: string[] = [];

    const searchForBridge = (baseDir: string, depth = 0, maxDepth = 3) => {
      if (depth > maxDepth || !baseDir || !fs.existsSync(baseDir)) return;

      try {
        const contents = fs.readdirSync(baseDir, { withFileTypes: true });

        for (const item of contents) {
          if (!item.isDirectory()) continue;

          const itemPath = path.join(baseDir, item.name);

          if (item.name === "panelbridge") {
            try {
              const serverFolders = fs.readdirSync(itemPath, {
                withFileTypes: true,
              });
              for (const sf of serverFolders) {
                if (!sf.isDirectory()) continue;

                const serverPath = path.join(itemPath, sf.name);
                const statusFile = path.join(serverPath, "status.json");
                const initFile = path.join(serverPath, ".init");
                const hasStatus = fs.existsSync(statusFile);
                const hasInit = fs.existsSync(initFile);

                let statusAge = null;
                let modVersion = null;
                if (hasStatus) {
                  try {
                    const stats = fs.statSync(statusFile);
                    statusAge = Date.now() - stats.mtimeMs;
                    const content = JSON.parse(
                      fs.readFileSync(statusFile, "utf-8"),
                    );
                    modVersion = content.version;
                  } catch (e: any) {
                    log.debug(
                      `Failed to parse status for ${sf.name}: ${e.message}`,
                    );
                  }
                }

                foundBridges.push({
                  path: serverPath,
                  serverName: sf.name,
                  baseDir,
                  hasStatus,
                  hasInit,
                  statusAge,
                  modVersion,
                  isActive: statusAge !== null && statusAge < 60000, // Active if updated in last minute
                });
              }
            } catch (e: any) {
              log.debug(
                `Failed to scan panelbridge folder in ${itemPath}: ${e.message}`,
              );
            }
            continue;
          }

          if (item.name === "Lua") {
            const bridgePath = path.join(itemPath, "panelbridge");
            if (fs.existsSync(bridgePath)) {
              scannedDirs.push(bridgePath);
              searchForBridge(bridgePath, depth + 1, maxDepth);
            }
            continue;
          }

          if (
            item.name.startsWith("Server_files") ||
            item.name.match(/Server.*files/i)
          ) {
            scannedDirs.push(itemPath);
            searchForBridge(itemPath, depth + 1, maxDepth);
          }
        }
      } catch (e: any) {
        // Ignore errors reading directories
      }
    };

    const searchDirs = new Set<string>();

    if (activeServer?.installPath) {
      searchDirs.add(activeServer.installPath);
      searchDirs.add(path.dirname(activeServer.installPath));
    }

    if (activeServer?.zomboidDataPath) {
      searchDirs.add(activeServer.zomboidDataPath);
      searchDirs.add(path.dirname(activeServer.zomboidDataPath));
    }

    if (bridge.bridgePath) {
      const parts = bridge.bridgePath.split(path.sep);
      const panelbridgeIdx = parts.indexOf("panelbridge");
      if (panelbridgeIdx > 0) {
        searchDirs.add(parts.slice(0, panelbridgeIdx).join(path.sep));
      }
    }

    for (const dir of searchDirs) {
      if (dir) {
        scannedDirs.push(dir);
        searchForBridge(dir);
      }
    }

    res.json({
      foundBridges,
      scannedDirs: [...new Set(scannedDirs)],
      currentPath: bridge.bridgePath,
      isRunning: bridge.isRunning,
      modConnected: bridge.isModConnected(),
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/refresh", (req, res) => {
  try {
    if (bridge.isRunning) {
      bridge.stop();
    }

    if (bridge.bridgePath) {
      bridge.start();
      res.json({
        success: true,
        message: "Bridge refreshed",
        bridgePath: bridge.bridgePath,
      });
    } else {
      res.json({
        success: false,
        message: "Bridge not configured - use auto-configure first",
      });
    }
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/ping", async (req, res) => {
  if (!bridge.bridgePath) {
    return res.status(400).json({
      error: "Bridge not configured",
      code: ErrorCode.BRIDGE_NOT_CONFIGURED,
    });
  }

  try {
    const result = await bridge.ping();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/command", async (req, res) => {
  const { action, args } = req.body || {};

  if (!action) {
    return res.status(400).json({
      error: "action is required",
      code: ErrorCode.PANELBRIDGE_ACTION_REQUIRED,
    });
  }

  if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
    return res.status(400).json({
      error: "Unknown or invalid action",
      code: ErrorCode.PANELBRIDGE_UNKNOWN_ACTION,
    });
  }

  if (
    args !== undefined &&
    (typeof args !== "object" || args === null || Array.isArray(args))
  ) {
    return res.status(400).json({
      error: "args must be an object",
      code: ErrorCode.PANELBRIDGE_ARGS_MUST_BE_OBJECT,
    });
  }

  if (!bridge.bridgePath) {
    return res.status(400).json({
      error: "Bridge not configured",
      code: ErrorCode.BRIDGE_NOT_CONFIGURED,
    });
  }

  if (!bridge.isRunning) {
    return res.status(400).json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }

  const startTime = Date.now();
  try {
    log.info(
      `POST /command: action=${action} args=${JSON.stringify(args || {}).substring(0, 200)}`,
    );
    const result = await bridge.sendCommand(action, args || {});
    const durationMs = Date.now() - startTime;
    log.debug(`POST /command: action=${action} completed in ${durationMs}ms`);
    logBridgeCommand(action, args, result, true, durationMs).catch(() => {});
    res.json(result);
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    const message = sanitizeError(error?.message || "Bridge command failed");
    logBridgeCommand(action, args, { error: message }, false, durationMs).catch(
      () => {},
    );

    const diagnosticFields =
      error?.data && typeof error.data === "object" ? error.data : {};

    if (/timeout/i.test(message)) {
      return res
        .status(504)
        .json({ ...diagnosticFields, error: message, category: "timeout" });
    }
    if (
      /not configured|not running|unhealthy|not responding|stale|missing/i.test(
        message,
      )
    ) {
      return res
        .status(503)
        .json({
          ...diagnosticFields,
          error: message,
          category: "bridge-unavailable",
        });
    }
    if (/invalid|required/i.test(message)) {
      return res
        .status(400)
        .json({ ...diagnosticFields, error: message, category: "validation" });
    }

    return res
      .status(500)
      .json({ ...diagnosticFields, error: message, category: "unknown" });
  }
});

router.get("/server-info", async (req, res) => {
  if (!bridge.bridgePath) {
    return res.status(400).json({
      error: "Bridge not configured",
      code: ErrorCode.BRIDGE_NOT_CONFIGURED,
    });
  }
  if (!bridge.isRunning) {
    return res.status(400).json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }

  try {
    const result = await bridge.getServerInfo();
    if (result?.data?.players && !Array.isArray(result.data.players)) {
      result.data.players = Object.values(result.data.players);
    }
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/world/stats", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.getWorldStats();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/world/save", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.saveWorld();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/players", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.getAllPlayerDetails();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/players/:username", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const username = String(req.params.username);
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  try {
    const result = await bridge.getPlayerDetails(username);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to get player details",
      code: ErrorCode.PANELBRIDGE_GET_PLAYER_DETAILS_FAILED,
    });
  }
});

router.post("/players/:username/teleport", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const username = String(req.params.username);
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  const { x, y, z } = req.body || {};
  if (x === undefined || y === undefined) {
    return res.status(400).json({
      error: "x and y coordinates are required",
      code: ErrorCode.BRIDGE_XY_COORDS_REQUIRED,
    });
  }
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    (z !== undefined && typeof z !== "number")
  ) {
    return res.status(400).json({
      error: "Coordinates must be numbers",
      code: ErrorCode.PANELBRIDGE_TELEPORT_COORDS_NOT_NUMBERS,
    });
  }
  if (x < 0 || x > 24000 || y < 0 || y > 24000) {
    return res.status(400).json({
        error: "x/y coordinates out of range (0-24000)",
        code: ErrorCode.PANELBRIDGE_TELEPORT_XY_OUT_OF_RANGE,
      });
  }
  if (z !== undefined && (z < 0 || z > 8)) {
    return res.status(400).json({
      error: "z coordinate out of range (0-8)",
      code: ErrorCode.PANELBRIDGE_TELEPORT_Z_OUT_OF_RANGE,
    });
  }
  try {
    const result = await bridge.teleportPlayer(username, x, y, z);
    res.json(result);
  } catch (error: any) {
    const diagnosticFields =
      error?.data && typeof error.data === "object" ? error.data : {};
    res.status(500).json({
      ...diagnosticFields,
      error: "Teleport failed",
      code: ErrorCode.PANELBRIDGE_TELEPORT_FAILED,
    });
  }
});

router.post("/message", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { message } = req.body || {};
  if (!message || typeof message !== "string" || message.length > 2000) {
    return res.status(400).json({
        error: "message is required (max 2000 chars)",
        code: ErrorCode.BRIDGE_MESSAGE_REQUIRED,
      });
  }
  try {
    const result = await bridge.sendCommand("sendToServerChat", {
      message,
      isAlert: true,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/sandbox", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.getSandboxOptions();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/commands", (_req, res) => {
  res.json({
    commands: PANEL_BRIDGE_COMMANDS,
  });
});

router.get("/mod-path", async (req, res) => {
  const possiblePaths = [
    path.join(
      __dirname,
      "..",
      "..",
      "..",
      "integrations",
      "panelbridge",
      "PanelBridge",
    ),
    path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
    path.join(process.cwd(), "pz-mod", "PanelBridge"),
  ];

  let modPath = possiblePaths[0];
  let exists = false;

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      modPath = p;
      exists = true;
      break;
    }
  }

  let suggestedInstallPath = null;
  try {
    const activeServer = await getActiveServer();
    if (activeServer?.installPath) {
      suggestedInstallPath = path.join(
        activeServer.installPath,
        "media",
        "lua",
        "server",
      );
    }
  } catch (e: any) {
    // Ignore
  }

  res.json({
    modPath,
    exists,
    files: exists ? fs.readdirSync(modPath) : [],
    suggestedInstallPath,
  });
});

router.post("/install-local", async (req, res) => {
  try {
    const server = await getActiveServer();
    if (!server) {
      return res.status(400).json({
          success: false,
          error: "No active server configured.",
          code: ErrorCode.PANELBRIDGE_NO_ACTIVE_SERVER,
        });
    }

    if (!canAutoInstall(server)) {
      return res.status(400).json({
        success: false,
        error:
          "Auto-install is not available for this server. It must be a local (non-remote) server with a writable install path and the PanelBridge source present.",
        code: ErrorCode.PANELBRIDGE_AUTO_INSTALL_NOT_AVAILABLE,
      });
    }

    const result = installBridge(server);
    if (!result.success) {
      return res.status(500).json(result);
    }

    res.json({
      ...result,
      message: `PanelBridge installed to ${result.targetPath}`,
      serverName: server.serverName || server.name,
    });
  } catch (error: any) {
    res
      .status(500)
      .json({ success: false, error: sanitizeError(error.message) });
  }
});

router.post("/install-mod-auto", async (req, res) => {
  try {
    const { serverId } = req.body || {};

    let targetServer;
    if (serverId) {
      targetServer = await getServer(serverId);
      if (!targetServer) {
        return res.status(400).json({
          error: `Server with ID ${serverId} not found.`,
          code: ErrorCode.PANELBRIDGE_SERVER_ID_NOT_FOUND,
          params: sanitizeErrorParams({ serverId }),
        });
      }
    } else {
      targetServer = await getActiveServer();
      if (!targetServer) {
        return res.status(400).json({
          error: "No active server configured.",
          code: ErrorCode.PANELBRIDGE_NO_ACTIVE_SERVER,
        });
      }
    }

    if (!canAutoInstall(targetServer)) {
      return res.status(400).json({
        error:
          "Automatic PanelBridge installation is unavailable. Configure an existing local server install folder with write permission, or use the manual install path.",
        code: ErrorCode.PANELBRIDGE_INSTALL_CANNOT_AUTO_INSTALL,
      });
    }

    const installResult = installBridge(targetServer);
    if (!installResult.success) {
      return res.status(500).json(installResult);
    }

    return res.json({
      ...installResult,
      message:
        installResult.message ||
        `PanelBridge installed to ${installResult.targetPath}`,
      serverName: targetServer.serverName || targetServer.name,
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/install-mod", async (req, res) => {
  const body = req.body || {};
  const { serverLuaPath } = body;

  const targetPath = serverLuaPath || body.serverModsPath;

  if (!targetPath) {
    return res.status(400).json({
        error: "serverLuaPath is required (path to media/lua/server/)",
        code: ErrorCode.PANELBRIDGE_SERVER_LUA_PATH_REQUIRED,
      });
  }

  if (typeof targetPath !== "string" || targetPath.length > 500) {
    return res.status(400).json({
      error: "Invalid path format",
      code: ErrorCode.PANELBRIDGE_SERVER_LUA_PATH_FORMAT_INVALID,
    });
  }

  if (!path.isAbsolute(targetPath)) {
    return res.status(400).json({
      error: "Must be an absolute path",
      code: ErrorCode.PANELBRIDGE_SERVER_LUA_PATH_NOT_ABSOLUTE,
    });
  }
  const resolvedTarget = path.resolve(targetPath);
  const normalizedTarget = resolvedTarget.replace(/\\/g, "/");
  const targetLower = normalizedTarget.toLowerCase();
  if (
    !targetLower.endsWith("/media/lua/server") &&
    !targetLower.endsWith("/media/lua/server/")
  ) {
    return res.status(400).json({
        error: "Path must point to a media/lua/server/ directory",
        code: ErrorCode.PANELBRIDGE_SERVER_LUA_PATH_WRONG_DIRECTORY,
      });
  }

  let allowedTarget: string | null = null;
  try {
    const servers = await getServers();
    const normalizePath = (value: string) => {
      const resolved = path.resolve(value);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const normalizedResolvedTarget = normalizePath(resolvedTarget);

    for (const server of servers) {
      let installDir;
      try {
        installDir = resolveInstallDir(server);
      } catch {
        continue;
      }
      if (!installDir || !path.isAbsolute(installDir)) {
        continue;
      }

      let canonicalInstallDir;
      try {
        canonicalInstallDir = fs.realpathSync(installDir);
      } catch {
        continue;
      }
      const candidate = path.join(
        canonicalInstallDir,
        "media",
        "lua",
        "server",
      );
      if (normalizePath(candidate) === normalizedResolvedTarget) {
        allowedTarget = candidate;
        break;
      }
    }
  } catch (error: any) {
    log.debug(
      `Configured PanelBridge target validation failed: ${error.message}`,
    );
  }

  if (!allowedTarget) {
    return res.status(400).json({
      error:
        "Path must match the media/lua/server directory of a configured local server",
      code: ErrorCode.PANELBRIDGE_SERVER_LUA_PATH_NOT_CONFIGURED,
    });
  }

  try {
    let srcContent = getEmbeddedPanelBridgeLua();

    if (!srcContent) {
      const possiblePaths = [
        path.join(
          __dirname,
          "..",
          "..",
          "..",
          "integrations",
          "panelbridge",
          "PanelBridge",
        ),
        path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
        path.join(process.cwd(), "pz-mod", "PanelBridge"),
      ];
      for (const p of possiblePaths) {
        const candidate = path.join(
          p,
          "media",
          "lua",
          "server",
          "PanelBridge.lua",
        );
        if (fs.existsSync(candidate)) {
          srcContent = fs.readFileSync(candidate, "utf8");
          break;
        }
      }
    }

    if (!srcContent) {
      return res.status(404).json({
        error: "Source mod not found (no embedded Lua and no on-disk pz-mod).",
        code: ErrorCode.PANELBRIDGE_SOURCE_MOD_NOT_FOUND,
      });
    }

    if (!fs.existsSync(allowedTarget)) {
      fs.mkdirSync(allowedTarget, { recursive: true, mode: 0o755 });
    }

    const destPath = path.join(allowedTarget, "PanelBridge.lua");
    writeLuaAtomic(destPath, srcContent);

    res.json({
      success: true,
      message: "PanelBridge.lua installed successfully",
      path: destPath,
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

async function persistUtilities(power: any, water: any, on: any) {
  const values: AnyRecord = {};
  if (power) {
    values.ElecShut = on ? 9 : 1;
    values.ElecShutModifier = on ? 2147483647 : 0;
  }
  if (water) {
    values.WaterShut = on ? 9 : 1;
    values.WaterShutModifier = on ? 2147483647 : 0;
  }
  try {
    const { persisted, reason } = await persistSandboxValues(values);
    if (!persisted) {
      log.warn(`Utilities not persisted to SandboxVars.lua: ${reason}`);
    }
    return { persisted, persistReason: reason };
  } catch (error: any) {
    log.error(
      `Failed to persist utilities to SandboxVars.lua: ${error.message}`,
    );
    return { persisted: false, persistReason: sanitizeError(error.message) };
  }
}

router.get("/utilities/status", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.sendCommand("getUtilitiesStatus", {});
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/utilities/restore", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { power, water } = req.body || {};
  log.info(
    `Restoring utilities - power: ${power !== false}, water: ${water !== false}`,
  );
  try {
    const result = await bridge.sendCommand("restoreUtilities", {
      power: power !== false,
      water: water !== false,
    });
    log.info(
      `Utilities restored successfully`,
      result?.debug ? { debug: result.debug } : {},
    );
    res.json({
      ...result,
      ...(await persistUtilities(power !== false, water !== false, true)),
    });
  } catch (error: any) {
    log.error(`Failed to restore utilities: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/utilities/shutoff", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { power, water } = req.body || {};
  log.info(
    `Shutting off utilities - power: ${power !== false}, water: ${water !== false}`,
  );
  try {
    const result = await bridge.sendCommand("shutOffUtilities", {
      power: power !== false,
      water: water !== false,
    });
    log.info(
      `Utilities shut off successfully`,
      result?.debug ? { debug: result.debug } : {},
    );
    res.json({
      ...result,
      ...(await persistUtilities(power !== false, water !== false, false)),
    });
  } catch (error: any) {
    log.error(`Failed to shut off utilities: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/players/:username/give-item", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const username = String(req.params.username);
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  const { itemType, count = 1 } = req.body || {};
  if (
    !itemType ||
    typeof itemType !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z][a-zA-Z0-9_]*$/.test(itemType)
  ) {
    return res.status(400).json({
      error: 'itemType must be in Module.ItemName format (e.g., "Base.Axe")',
    });
  }
  if (typeof count !== "number" || count < 1 || count > 100) {
    return res.status(400).json({
      error: "count must be 1-100",
      code: ErrorCode.PANELBRIDGE_HORDE_COUNT_INVALID,
    });
  }
  try {
    const result = await bridge.sendCommand("giveItem", {
      username,
      itemType,
      count,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/players/:username/heal", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const username = String(req.params.username);
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  try {
    const result = await bridge.sendCommand("healPlayer", { username });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/players/:username/kill", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const username = String(req.params.username);
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  try {
    const result = await bridge.sendCommand("killPlayer", { username });
    res.json(result);
  } catch (error: any) {
    const diagnosticFields =
      error?.data && typeof error.data === "object" ? error.data : {};
    res
      .status(500)
      .json({ ...diagnosticFields, error: sanitizeError(error.message) });
  }
});

router.post("/players/:username/godmode", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const username = String(req.params.username);
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  try {
    const result = await bridge.sendCommand("setGodMode", {
      username,
      enabled: enabled === true,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/players/:username/invisible", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const username = String(req.params.username);
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  try {
    const result = await bridge.sendCommand("setInvisible", {
      username,
      enabled: enabled === true,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/debug/log", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const limit = parseClampedInteger(req.query.limit, 50, 1, 500);
  const VALID_LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"];
  const requestedLevel =
    typeof req.query.level === "string" ? req.query.level : "";
  const minLevel = VALID_LOG_LEVELS.includes(requestedLevel)
    ? requestedLevel
    : "DEBUG";
  try {
    const result = await bridge.sendCommand("getDebugLog", { limit, minLevel });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/debug/stats", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  try {
    const result = await bridge.sendCommand("getStats", {});
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/debug/mode", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  try {
    const result = await bridge.sendCommand("setDebugMode", {
      enabled: enabled === true,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/debug/api", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { object, method } = req.query;
  if (
    object &&
    (typeof object !== "string" || !/^[a-zA-Z0-9_.]{1,100}$/.test(object))
  ) {
    return res.status(400).json({
      error: "Invalid object name",
      code: ErrorCode.PANELBRIDGE_INVALID_OBJECT_NAME,
    });
  }
  if (
    method &&
    (typeof method !== "string" || !/^[a-zA-Z0-9_.]{1,100}$/.test(method))
  ) {
    return res.status(400).json({
      error: "Invalid method name",
      code: ErrorCode.PANELBRIDGE_INVALID_METHOD_NAME,
    });
  }
  try {
    const result = await bridge.sendCommand("checkAPI", { object, method });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/debug/handlers", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  try {
    const result = await bridge.sendCommand("getAvailableHandlers", {});
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/debug/clear-errors", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  try {
    const result = await bridge.clearErrors();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/catalog/items", async (req, res) => {
  try {
    const db = await getDb();
    const catalog = db.data.itemCatalog || null;
    if (!catalog) {
      return res.json({ items: [], count: 0, scannedAt: null });
    }
    res.json(catalog);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/catalog/scan-items", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running — server must be online to scan items",
      code: ErrorCode.PANELBRIDGE_SCAN_ITEMS_NOT_RUNNING,
    });
  }
  try {
    log.info("Scanning item catalog via PanelBridge...");
    const result = await bridge.sendCommand("getItemCatalog", {});
    if (!result || !result.success) {
      return res
        .status(500)
        .json({ error: result?.error || "Item scan failed" });
    }
    const catalog = {
      items: result.data?.items || [],
      count: result.data?.count || 0,
      scannedAt: new Date().toISOString(),
    };
    const db = await getDb();
    db.data.itemCatalog = catalog;
    await commitNow();
    log.info(`Item catalog cached: ${catalog.count} items`);
    res.json(catalog);
  } catch (error: any) {
    log.error("Item catalog scan failed:", error.message);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/catalog/debug-item-script", async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  try {
    const result = await bridge.sendCommand("debugItemScript", {});
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
