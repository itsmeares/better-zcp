import "./utils/firstRunOwnershipCheck.js";
import express from "express";
import compression from "compression";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { permissionsPolicy } from "./middleware/permissionsPolicy.ts";
import { logSetupTokenIfNeeded } from "./utils/setupToken.ts";
import { computeInlineScriptCspHash } from "./utils/cspScriptHash.ts";
import { parseTrustProxySetting } from "./utils/trustProxy.ts";
import { isUncompressedBinaryProxyPath } from "./utils/compressionFilter.ts";
import { createServer } from "http";
import { createServer as createHttpsServer } from "https";
import { Server } from "socket.io";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import os from "os";
import readline from "readline";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { exec, execSync, spawn } from "child_process";
import cookieParser from "cookie-parser";

import {
  onLog,
  createLogger,
  logSection,
  logBanner,
  logReady,
} from "./utils/logger.js";
const log = createLogger("Panel");
import {
  initDatabase,
  getActiveServer,
  getAllSettings,
  getServers,
  getSetting,
  setSetting,
  flushWrites,
  flushForShutdown,
  closeDatabase,
  recordPerformanceSnapshot,
  logServerEvent,
  getDatabaseFilePath,
} from "./database/init.js";
import { RconService } from "./services/rcon.js";
import { ServerManager } from "./services/serverManager.js";
import { DockerClient } from "./services/dockerClient.ts";
import { setDockerClient } from "./services/managedContainer.js";
import { ModChecker } from "./services/modChecker.js";
import { Scheduler } from "./services/scheduler.js";
import { DiscordBot } from "./services/discordBot.js";
import { BackupService } from "./services/backupService.js";
import { UpdateChecker } from "./services/updateChecker.js";
import {
  PanelUpdateChecker,
  createUpdateDataBackup,
  restorePreUpdateDataBackup,
} from "./services/panelUpdateChecker.js";
import {
  acknowledgeUpdateBundle,
  applyUpdateBundle,
  inspectPendingUpdateBundle,
  PANEL_API_CONTRACT_VERSION as DEFAULT_API_CONTRACT_VERSION,
  recoverInterruptedUpdateBundle,
} from "./services/updateBundle.js";
import { LogTailer } from "./services/logTailer.js";
import { DiskMonitor } from "./services/diskMonitor.js";
import authService from "./services/auth.js";
import { getRoleByName } from "./services/permissions.js";
import { requireRole } from "./services/auth.js";
import authRoutes from "./routes/auth.js";
import oidcRoutes from "./routes/oidc.js";
import { loadOrCreateCerts } from "./utils/certs.js";
import { sanitizeError, sanitizeErrorParams } from "./utils/sanitize.ts";
import { ErrorCode } from "./utils/errorCodes.js";
import { getSftpCachePath } from "./services/panelBridgeSftp.js";
import { resolveInstallDir } from "./services/panelBridgeInstaller.js";
import {
  getEmbeddedPanelBridgeLua,
  compareModVersions,
  writeLuaAtomic,
} from "./utils/embeddedLua.ts";
import {
  clientDistMatchesMetadata,
  getEmbeddedClientDistPath,
  readClientDistMetadata,
  resolveClientDistPath,
} from "./utils/embeddedClient.ts";
import { resolveObservedServerRunning } from "./utils/serverStatus.ts";
import { discoverMounts } from "./services/mountDiscovery.js";
import { shouldAutoOpenBrowser } from "./utils/browserLaunch.ts";
import { isLinuxPanelSupervisor } from "./utils/restartSupervisor.ts";
import { acquireLifecycleLock } from "./services/lifecycleCoordinator.ts";

(function maybeReexecViaSupervisor() {
  try {
    if (process.platform !== "win32") return;
    if (typeof process.pkg === "undefined") return;
    if (process.env.PANEL_SUPERVISOR_V === "2") return;
    if (process.env.PANEL_NO_SUPERVISOR === "1") return;
    const exeDir = path.dirname(process.execPath.replace(/\.new2?$/i, ""));
    const startBat = path.join(exeDir, "Start.bat");
    if (!fs.existsSync(startBat)) return;
    const child = spawn(
      process.env.ComSpec || "cmd.exe",
      ["/c", "start", "", startBat],
      {
        detached: true,
        stdio: "ignore",
        cwd: exeDir,
        windowsHide: false,
      },
    );
    child.unref();
    process.exit(0);
  } catch (err) {
    console.error(
      "Supervisor bootstrap failed, continuing without it:",
      err.message,
    );
  }
})();

process.stdout?.on?.("error", (err) => {
  if (err.code !== "EPIPE") throw err;
});
process.stderr?.on?.("error", (err) => {
  if (err.code !== "EPIPE") throw err;
});

// Global error handlers.
function fatalExit(label, err) {
  log.error(`${label}:`, err);
  Promise.race([
    flushWrites().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]).finally(() => process.exit(1));
}

process.on("uncaughtException", (error) => {
  if (error && error.code === "EPIPE") return;
  fatalExit("Uncaught Exception", error);
});

process.on("unhandledRejection", (reason) => {
  fatalExit("Unhandled Rejection", reason);
});

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info(`Received ${signal}, shutting down gracefully...`);

  try {
    stopPlayerPolling();

    stopPerfPolling();

    if (scheduler) {
      scheduler.stopAllJobs?.();
    }

    if (modChecker) {
      modChecker.stop();
    }

    if (logTailer) {
      logTailer.stopWatching();
    }

    if (updateChecker) {
      updateChecker.stop();
    }

    if (panelUpdateChecker) {
      panelUpdateChecker.stop();
    }

    if (diskMonitor) {
      diskMonitor.stop();
    }

    if (panelBridge?.isRunning) {
      panelBridge.stop();
    }

    if (rconService) {
      rconService.stopAutoReconnect();
      if (rconService.connected) {
        await rconService.disconnect();
      }
    }

    await flushForShutdown();

    httpServer.close(() => {
      log.info("HTTP server closed");
      process.exit(0);
    });

    setTimeout(() => {
      log.warn("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10000);
  } catch (error) {
    log.error("Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

import serverRoutes from "./routes/server.js";
import discoveryRoutes from "./routes/discovery.js";
import serversRoutes from "./routes/servers.js";
import serverStatusRoutes from "./routes/serverStatus.js";
import serverFilesRoutes from "./routes/serverFiles.js";
import playerRoutes from "./routes/players.js";
import rconRoutes from "./routes/rcon.js";
import configRoutes from "./routes/config.js";
import schedulerRoutes from "./routes/scheduler.js";
import modsRoutes from "./routes/mods.js";
import chunksRoutes from "./routes/chunks.js";
import discordRoutes from "./routes/discord.js";
import debugRoutes, { addLogToBuffer } from "./routes/debug.js";
import { getDiskFree } from "./utils/diskSpace.js";
import { getSwapInfo } from "./utils/swapInfo.js";
import serverFinderRoutes from "./routes/serverFinder.js";
import panelBridgeRoutes from "./routes/panelBridge.js";
import backupRoutes from "./routes/backup.js";
import mapProxyRoutes from "./routes/mapProxy.js";
import systemRoutes from "./routes/system.js";
import templatesRoutes from "./routes/templates.js";
import dockerRoutes from "./routes/docker.js";
import permissionsRoutes from "./routes/permissions.js";
import panelBridge from "./services/panelBridge.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const trustProxyEnv = process.env.TRUST_PROXY || "";
let trustProxySetting = parseTrustProxySetting(trustProxyEnv);
try {
  app.set("trust proxy", trustProxySetting);
} catch (error) {
  log.warn(
    `Invalid TRUST_PROXY value (${trustProxyEnv}), proxy trust disabled: ${error.message}`,
  );
  trustProxySetting = false;
  app.set("trust proxy", false);
}
if (trustProxySetting) {
  const configuredProxy = Array.isArray(trustProxySetting)
    ? trustProxySetting.join(",")
    : trustProxySetting;
  log.info(
    `trust proxy enabled (${configuredProxy}) via TRUST_PROXY env var`,
  );
}
const httpServer = createServer(app);
let activePanelPort = null;

let httpsServer = null;

export function isHttpsServerActive() {
  return httpsServer !== null;
}

const defaultAllowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3001",
];
const allowedOrigins = new Set(defaultAllowedOrigins);
const MAX_CORS_BLOCK_EVENTS = 50;
const MAX_CORS_CUSTOM_ORIGINS = 100;
const MAX_CORS_ORIGIN_LENGTH = 256;
const CORS_DENY_MESSAGE =
  "Origin blocked by panel CORS policy. Open the panel from a local/LAN host, or for first-time reverse-proxy setup set CORS_ORIGINS=https://your-panel-host in the panel environment and restart it. After setup, this origin can be managed in Settings > Remote Access.";
const corsState = {
  allowAll: false,
  allowPrivateNetworks: true,
  debug: false,
  customOrigins: new Set(),
  blocked: [],
  lastLoadedAt: null,
};

function normalizeOrigin(origin) {
  if (typeof origin !== "string") return null;
  const trimmed = origin.trim();
  if (trimmed.length > MAX_CORS_ORIGIN_LENGTH) return null;
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch (_) {
    return null;
  }
}

function parseOriginList(rawOrigins) {
  if (typeof rawOrigins !== "string") return [];
  const parsed = rawOrigins
    .split(/[\n,;]+/)
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);
  return [...new Set(parsed)].slice(0, MAX_CORS_CUSTOM_ORIGINS);
}

function isPrivateNetworkHost(host) {
  if (!host) return false;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    // CGNAT/Tailscale range is 100.64.0.0/10 (second octet 64-127), NOT the
    // whole 100.0.0.0/8. `host.startsWith("100.")` used to match all of
    // 100.0.0.0-100.63.255.255 too, which are regular public IPv4 addresses.
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

function isLikelyLanHostname(host) {
  if (!host) return false;
  const normalized = String(host).trim().toLowerCase();
  if (!normalized) return false;

  if (/^[a-z0-9-]+$/.test(normalized) && !normalized.includes(".")) {
    return true;
  }

  if (
    normalized.endsWith(".local") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }

  return false;
}

function recordCorsBlock(origin, source) {
  if (!corsState.debug) return;
  const normalizedOrigin = typeof origin === "string" ? origin.trim() : "";
  const safeOrigin = normalizedOrigin
    ? normalizedOrigin.slice(0, MAX_CORS_ORIGIN_LENGTH)
    : "null";
  const entry = {
    id: randomUUID(),
    origin: safeOrigin,
    source,
    blockedAt: new Date().toISOString(),
  };
  corsState.blocked.unshift(entry);
  if (corsState.blocked.length > MAX_CORS_BLOCK_EVENTS) {
    corsState.blocked = corsState.blocked.slice(0, MAX_CORS_BLOCK_EVENTS);
  }
}

const MAX_ALLOWED_ORIGINS = 200;
function addAllowedOrigin(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return;
  if (
    allowedOrigins.size >= MAX_ALLOWED_ORIGINS &&
    !allowedOrigins.has(normalized)
  ) {
    return;
  }
  allowedOrigins.add(normalized);
}

function rebuildAllowedOriginsFromSettings(settings = {}) {
  allowedOrigins.clear();
  for (const origin of defaultAllowedOrigins) {
    addAllowedOrigin(origin);
  }

  const customOrigins = parseOriginList(settings.corsAllowedOrigins || "");
  corsState.customOrigins = new Set(customOrigins);
  for (const origin of customOrigins) {
    addAllowedOrigin(origin);
  }

  const httpsEnabled = settings.httpsEnabled === true;
  const httpsPort = parseInt(settings.httpsPort, 10);
  if (httpsEnabled) {
    addAllowedOrigin(
      `https://localhost:${Number.isNaN(httpsPort) ? 3443 : httpsPort}`,
    );
  }

  const envOrigins = process.env.CORS_ORIGINS;
  if (envOrigins) {
    const parsed = parseOriginList(envOrigins);
    for (const origin of parsed) {
      addAllowedOrigin(origin);
    }
  }
}

function getCorsDebugSnapshot() {
  return {
    allowAll: corsState.allowAll,
    allowPrivateNetworks: corsState.allowPrivateNetworks,
    debug: corsState.debug,
    customOrigins: [...corsState.customOrigins],
    effectiveAllowedOrigins: [...allowedOrigins].sort(),
    blocked: corsState.blocked,
    blockedCount: corsState.blocked.length,
    lastLoadedAt: corsState.lastLoadedAt,
  };
}

function clearCorsBlockedOrigins() {
  corsState.blocked = [];
}

async function refreshCorsConfig() {
  const settings = await getAllSettings();
  corsState.allowAll = settings?.corsAllowAll === true;
  corsState.allowPrivateNetworks = settings?.corsAllowPrivateNetworks !== false;
  corsState.debug = settings?.corsDebug === true;
  rebuildAllowedOriginsFromSettings(settings || {});
  corsState.lastLoadedAt = new Date().toISOString();

  log.info(
    `CORS config loaded: allowAll=${corsState.allowAll}, privateNetworks=${corsState.allowPrivateNetworks}, customOrigins=${corsState.customOrigins.size}, debug=${corsState.debug}`,
  );

  return getCorsDebugSnapshot();
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (corsState.allowAll) return true;

  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (allowedOrigins.has(normalized)) return true;

  try {
    const url = new URL(normalized);
    if (
      corsState.allowPrivateNetworks &&
      (isPrivateNetworkHost(url.hostname) || isLikelyLanHostname(url.hostname))
    ) {
      addAllowedOrigin(normalized);
      return true;
    }
  } catch (_) {
    // Unparseable origin: fall through and deny.
  }

  return false;
}

const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        recordCorsBlock(origin, "socket");
        callback(new Error(CORS_DENY_MESSAGE));
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});

export function setupHttpsServer({
  httpsEnabled,
  httpsPort,
  customKeyPath,
  customCertPath,
}) {
  if (!httpsEnabled) return null;

  let certs = null;
  try {
    certs = loadOrCreateCerts(customKeyPath, customCertPath);
  } catch (error) {
    log.error(
      `HTTPS certificate setup failed unexpectedly: ${error.message} — running HTTP only`,
    );
    return null;
  }
  if (!certs) {
    log.warn(
      "HTTPS enabled but certificate generation failed — running HTTP only",
    );
    return null;
  }

  try {
    httpsServer = createHttpsServer(certs, app);
  } catch (error) {
    log.error(
      `HTTPS certificate/key content is invalid: ${error.message} — running HTTP only`,
    );
    httpsServer = null;
    return null;
  }
  addAllowedOrigin(`https://localhost:${httpsPort}`);
  io.attach(httpsServer, {
    cors: {
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
          callback(null, true);
        } else {
          callback(new Error(CORS_DENY_MESSAGE));
        }
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  httpsServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log.error(
        `HTTPS port ${httpsPort} is already in use. Find the offender with: ${process.platform === "win32" ? `netstat -ano | findstr :${httpsPort}` : `ss -tlnp | grep :${httpsPort}  (or: lsof -i :${httpsPort})`}`,
      );
    }
    log.error(
      `HTTPS server error: ${err.message} — HTTPS disabled, HTTP is unaffected and continues starting normally`,
    );
    httpsServer = null;
  });

  try {
    httpsServer.listen(httpsPort, () => {
      log.info(`HTTPS server listening on port ${httpsPort}`);
    });
  } catch (error) {
    log.error(
      `Invalid HTTPS port ${JSON.stringify(httpsPort)}: ${error.message} — HTTPS disabled, HTTP is unaffected`,
    );
    httpsServer = null;
  }

  return httpsServer;
}

const httpsDetected =
  process.env.HTTPS === "true" || process.env.FORCE_HSTS === "true";

const externalClientDistPath =
  typeof process.pkg !== "undefined"
    ? path.join(path.dirname(process.execPath), "client", "dist")
    : path.join(__dirname, "../panel-client/dist");
const embeddedClientDistPath =
  typeof process.pkg !== "undefined" ? getEmbeddedClientDistPath() : null;
const cspClientDistPath = resolveClientDistPath({
  packaged: typeof process.pkg !== "undefined",
  embeddedPath: embeddedClientDistPath,
  externalPath: externalClientDistPath,
});
let inlineScriptCspSource = computeInlineScriptCspHash(
  cspClientDistPath,
  log,
);
function refreshInlineScriptCspHash() {
  inlineScriptCspSource = computeInlineScriptCspHash(cspClientDistPath, log);
  return inlineScriptCspSource;
}
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", () => inlineScriptCspSource || ""],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: httpsDetected ? [] : null,
      },
    },
    hsts: httpsDetected
      ? { maxAge: 31536000, includeSubDomains: false }
      : false,
    crossOriginEmbedderPolicy: false, // Allow loading resources
  }),
);
app.use(permissionsPolicy());

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        recordCorsBlock(origin, "http");
        log.warn(`CORS blocked request from origin: ${origin}`);
        callback(new Error(CORS_DENY_MESSAGE));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  }),
);

app.use("/api/debug/client-errors", express.json({ limit: "16kb" }));

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(
  compression({
    threshold: 1024,
    filter: (req, res) => {
      if (isUncompressedBinaryProxyPath(req)) return false;
      return compression.filter(req, res);
    },
  }),
);

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
app.use("/api/", apiLimiter);

app.use("/api/", (req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
});
app.use(authService.middleware());

const strictLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10, // 10 per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded for this operation." },
});
app.use("/api/server/install", strictLimiter);
app.use("/api/server/delete-files", strictLimiter);
app.use("/api/server/wipe", strictLimiter);
app.use("/api/server/steam-update", strictLimiter);
app.use("/api/server/steamcmd/download", strictLimiter);
app.use("/api/server/start", strictLimiter);
app.use("/api/server/stop", strictLimiter);
app.use("/api/server/force-stop", strictLimiter);
app.use("/api/server/restart", strictLimiter);
app.use("/api/docker/containers", strictLimiter);
app.use("/api/backup/restore", strictLimiter);
app.use("/api/backup/delete-older-than", strictLimiter);
app.use("/api/backup/upload", strictLimiter);
app.delete("/api/backup/:name", strictLimiter);
app.use("/api/chunks/delete-chunks", strictLimiter);
app.use("/api/chunks/delete-region", strictLimiter);
app.use("/api/server-files/raw", strictLimiter);
app.use("/api/server-files/restore", strictLimiter);
app.use("/api/server-files/save-and-reload", strictLimiter);
app.use("/api/panel-bridge/install-mod", strictLimiter);
app.use("/api/panel-bridge/install-local", strictLimiter);
app.use("/api/panel-bridge/character/export", strictLimiter);
app.use("/api/panel-bridge/character/import", strictLimiter);
app.use("/api/panel/update-check", strictLimiter);
app.use("/api/panel/update-download", strictLimiter);
app.use("/api/panel/update-preflight", strictLimiter);
app.use("/api/panel/restart", strictLimiter);
app.use("/api/templates/:id/apply", strictLimiter);
app.use("/api/mods/collection/extract-cookies", strictLimiter);

const collectionMutationLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many collection changes. Please wait a minute and try again." },
});
app.use("/api/mods/collection/items", collectionMutationLimiter);

const rconLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60, // 60 commands per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many RCON commands, please slow down." },
});
app.use("/api/rcon/execute", rconLimiter);

const panelBridgeCommandLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60, // 60 commands per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many PanelBridge commands, please slow down." },
});
app.use("/api/panel-bridge/command", panelBridgeCommandLimiter);

const clientErrorLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10, // 10 reports per minute per IP — a real crash storm from one tab
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many error reports, please slow down." },
});
app.use("/api/debug/client-errors", clientErrorLimiter);

const rconService = new RconService();
const serverManager = new ServerManager();
const dockerClient = new DockerClient();
setDockerClient(dockerClient);
const modChecker = new ModChecker();
const logTailer = new LogTailer();
const scheduler = new Scheduler(rconService, serverManager);
const discordBot = new DiscordBot(
  rconService,
  serverManager,
  scheduler,
  logTailer,
);
const backupService = new BackupService();

rconService.setServerManager(serverManager);
scheduler.setBackupService(backupService);

scheduler.setDiscordBot(discordBot);
scheduler.setIo(io);
backupService.setDiscordBot(discordBot);

rconService.startAutoReconnect();

async function findPanelBridgePath() {
  const activeServer = await getActiveServer();
  if (!activeServer) {
    return { error: "No active server configured" };
  }

  const serverName = activeServer.serverName || activeServer.name;
  if (!serverName) {
    return { error: "Server name not configured" };
  }

  const settings = await getAllSettings();
  if (settings?.panelBridge?.bridgePath) {
    const savedPath = settings.panelBridge.bridgePath;
    const statusFile = path.join(savedPath, "status.json");
    if (fs.existsSync(statusFile)) {
      return { path: savedPath, source: "db.json (saved)", serverName };
    }
  }

  const possiblePaths = [];

  const safeReadDir = (dirPath) => {
    try {
      return fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : [];
    } catch (e) {
      return [];
    }
  };

  if (activeServer.zomboidDataPath) {
    possiblePaths.push({
      p: path.join(
        activeServer.zomboidDataPath,
        "Lua",
        "panelbridge",
        serverName,
      ),
      source: "zomboidDataPath/Lua (cachedir)",
      priority: 1,
    });
  }

  if (activeServer.installPath) {
    const parentDir = path.dirname(activeServer.installPath);
    const parentContents = safeReadDir(parentDir);
    for (const item of parentContents) {
      if (item.startsWith("Server_files") || item.match(/Server.*files/i)) {
        possiblePaths.push({
          p: path.join(parentDir, item, "Lua", "panelbridge", serverName),
          source: `${item}/Lua`,
          priority: 2,
        });
      }
    }
  }

  if (activeServer.installPath) {
    possiblePaths.push({
      p: path.join(activeServer.installPath, "Lua", "panelbridge", serverName),
      source: "installPath/Lua",
      priority: 3,
    });
  }

  for (const { p, source } of possiblePaths) {
    const statusFile = path.join(p, "status.json");
    if (fs.existsSync(statusFile)) {
      return { path: p, source, serverName };
    }
  }

  for (const { p, source } of possiblePaths) {
    const initFile = path.join(p, ".init");
    if (fs.existsSync(initFile)) {
      return { path: p, source: `${source} (.init)`, serverName };
    }
  }

  for (const { p, source } of possiblePaths) {
    if (fs.existsSync(p)) {
      return { path: p, source: `${source} (exists)`, serverName };
    }
  }

  if (possiblePaths.length > 0) {
    possiblePaths.sort((a, b) => a.priority - b.priority);
    const bestPath = possiblePaths[0];
    return {
      path: bestPath.p,
      source: `${bestPath.source} (expected)`,
      serverName,
      notCreated: true,
    };
  }

  return {
    error: "No valid bridge path could be determined",
    searchedPaths: possiblePaths.map((x) => x.p),
    serverName,
  };
}

async function tryStartPanelBridge(trigger = "unknown") {
  if (panelBridge.isRunning) {
    log.debug(`Already running (trigger: ${trigger})`);
    return true;
  }

  const settings = await getAllSettings();
  if (settings?.panelBridgeSftpEnabled) {
    try {
      const sftpConfig = {
        host: settings.panelBridgeSftpHost,
        port: settings.panelBridgeSftpPort,
        username: settings.panelBridgeSftpUsername,
        password: settings.panelBridgeSftpPassword,
        bridgePath: settings.panelBridgeSftpBridgePath,
        pollIntervalSeconds: settings.panelBridgeSftpPollIntervalSeconds,
      };
      await panelBridge.configureSftp(sftpConfig, getSftpCachePath(sftpConfig));
      log.info(`Started SFTP transport (trigger: ${trigger})`);
      return true;
    } catch (error) {
      log.warn(`Could not start configured SFTP transport: ${error.message}`);
    }
  }

  const result = await findPanelBridgePath();

  if (result.error) {
    log.debug(`${result.error} (trigger: ${trigger})`);
    return false;
  }

  const autoUpdateEnabled =
    (await getSetting("panelBridgeAutoUpdate")) !== false;
  if (!autoUpdateEnabled) {
    log.debug("PanelBridge mod auto-update disabled by setting");
  }
  if (autoUpdateEnabled)
    try {
      const activeServer = await getActiveServer();
      const installDir = resolveInstallDir(activeServer);
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
            path.join(__dirname, "..", "..", "integrations", "panelbridge", "PanelBridge"),
            path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
            path.join(process.cwd(), "pz-mod", "PanelBridge"),
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

        if (srcContent && fs.existsSync(destLuaFile)) {
          const destContent = fs.readFileSync(destLuaFile, "utf8");
          const srcVersion = (srcContent.match(/VERSION\s*=\s*"([^"]+)"/) ||
            [])[1];
          const destVersion = (destContent.match(/VERSION\s*=\s*"([^"]+)"/) ||
            [])[1];
          if (
            srcVersion &&
            destVersion &&
            compareModVersions(srcVersion, destVersion) > 0
          ) {
            writeLuaAtomic(destLuaFile, srcContent);
            log.info(
              `PanelBridge mod auto-updated on server: ${destVersion} → ${srcVersion}`,
            );
          }
        } else if (srcContent && !fs.existsSync(destLuaFile)) {
          writeLuaAtomic(destLuaFile, srcContent);
          log.info("PanelBridge mod auto-installed to server");
        }
      }
    } catch (modError) {
      log.warn(`Auto-update mod check failed: ${modError.message}`);
    }

  try {
    panelBridge.configure(result.path, true);
    panelBridge.start();
    log.info(`Started from ${result.source} (trigger: ${trigger})`);
    return true;
  } catch (error) {
    log.warn(`Failed to start - ${error.message}`);
    return false;
  }
}

rconService.on("connected", async () => {
  try {
    log.info("RCON connected - checking PanelBridge...");
    rconConnectedAt = Date.now();
    lastPlayerList = [];
    playerBaselineReady = false;
    await tryStartPanelBridge("rcon-connected");
  } catch (err) {
    log.debug(`RCON-connected PanelBridge check failed: ${err.message}`);
  }
});

rconService.on("disconnected", () => {
  setTimeout(() => {
    checkServerStatusNow("RCON disconnect");
  }, 3000);
});

panelBridge.on("started", () => {
  io.emit("panelBridge:status", {
    isRunning: true,
    bridgePath: panelBridge.bridgePath,
  });
});

panelBridge.on("stopped", () => {
  io.emit("panelBridge:status", {
    isRunning: false,
    bridgePath: panelBridge.bridgePath,
  });
});

panelBridge.on("modStatus", (status) => {
  io.emit("panelBridge:modStatus", status);
});

panelBridge.on("configured", ({ path }) => {
  io.emit("panelBridge:configured", { bridgePath: path });
});

panelBridge.on("playerConnect", (playerName) => {
  discordBot
    .sendEventNotification("playerJoin", { player: playerName })
    .catch((err) =>
      log.debug(`Discord playerJoin notification failed: ${err.message}`),
    );
  getSetting("autoExportOnLogin")
    .then((autoExport) => {
      if (autoExport === true || autoExport === "true") {
        setTimeout(() => autoExportPlayer(playerName), 10000);
      }
    })
    .catch(() => {});
});

panelBridge.on("playerDisconnect", (playerName) => {
  discordBot
    .sendEventNotification("playerLeave", { player: playerName })
    .catch((err) =>
      log.debug(`Discord playerLeave notification failed: ${err.message}`),
    );
});

app.set("rconService", rconService);
app.set("serverManager", serverManager);
app.set("dockerClient", dockerClient);
app.set("modChecker", modChecker);
app.set("scheduler", scheduler);
app.set("discordBot", discordBot);
backupService.setServerManager(serverManager);
app.set("backupService", backupService);
app.set("io", io);
app.set("refreshCorsConfig", refreshCorsConfig);
app.set("getCorsDebugSnapshot", getCorsDebugSnapshot);
app.set("clearCorsBlockedOrigins", clearCorsBlockedOrigins);
app.set("checkServerStatusNow", checkServerStatusNow);

const updateChecker = new UpdateChecker(io, { rconService, serverManager });
app.set("updateChecker", updateChecker);

const panelUpdateChecker = new PanelUpdateChecker(io);
app.set("panelUpdateChecker", panelUpdateChecker);

const diskMonitor = new DiskMonitor(io);
app.set("diskMonitor", diskMonitor);

app.use("/api/auth", authRoutes);
app.use("/api/auth/oidc", oidcRoutes);

app.use("/api/server", serverRoutes);
app.use("/api/servers", discoveryRoutes);
app.use("/api/servers", serversRoutes);
app.use("/api/servers", serverStatusRoutes);
app.use("/api/server-files", serverFilesRoutes);
app.use("/api/players", playerRoutes);
app.use("/api/rcon", rconRoutes);
app.use("/api/config", configRoutes);
app.use("/api/scheduler", schedulerRoutes);
app.use("/api/mods", modsRoutes);
app.use("/api/chunks", chunksRoutes);
app.use("/api/discord", discordRoutes);
app.use("/api/debug", debugRoutes);
app.use("/api/server-finder", serverFinderRoutes);
app.use("/api/panel-bridge", panelBridgeRoutes);
app.use("/api/backup", backupRoutes);
app.use("/api/map", mapProxyRoutes);
app.use("/api/system", systemRoutes);
app.use("/api/templates", templatesRoutes);
app.use("/api/docker", dockerRoutes);
app.use("/api/permissions", permissionsRoutes);

let _pkgVersion;
let _buildSha;
try {
  _pkgVersion =
    typeof PANEL_VERSION !== "undefined"
      ? PANEL_VERSION
      : JSON.parse(
          fs.readFileSync(path.join(__dirname, "../../package.json"), "utf-8"),
        ).version;
} catch {
  _pkgVersion = "0.0.0";
}
try {
  _buildSha =
    typeof PANEL_BUILD_SHA !== "undefined"
      ? PANEL_BUILD_SHA
      : process.env.PANEL_BUILD_SHA ||
        execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
} catch {
  _buildSha = "unknown";
}
const _apiContractVersion =
  typeof PANEL_API_CONTRACT_VERSION !== "undefined"
    ? Number(PANEL_API_CONTRACT_VERSION)
    : DEFAULT_API_CONTRACT_VERSION;
const _buildMetadata = {
  panelVersion: _pkgVersion,
  buildSha: _buildSha,
  apiContractVersion: _apiContractVersion,
};

function updateBundleJournalPath() {
  return path.join(path.dirname(panelUpdateChecker.getExeBasePath()), "update-bundle.json");
}

let _pendingUpdateInspection = { pending: false, awaitingStartupAck: false };

function inspectPendingPanelUpdate() {
  const journalPath = updateBundleJournalPath();
  return inspectPendingUpdateBundle({
    journalPath,
    applyingMarkerPath: path.join(path.dirname(journalPath), ".update-applying"),
    runningMetadata: _buildMetadata,
  });
}
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    version: _pkgVersion,
    ..._buildMetadata,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/panel-info", async (req, res) => {
  const savedPort = await getSetting("panelPort");
  const PORT = activePanelPort || process.env.PORT || savedPort || 3001;
  const localIp = await serverManager.getLocalIp();
  res.json({
    localIp,
    port: parseInt(PORT, 10),
    url: `http://${localIp}:${PORT}`,
  });
});

app.post("/api/panel/restart", requireRole("admin"), async (req, res) => {
  log.info("Panel restart requested via API");

  const checker = req.app.get("panelUpdateChecker");
  const isPackaged = typeof process.pkg !== "undefined";
  const isWindows = process.platform === "win32";
  const staged =
    checker && typeof checker.getStagedUpdate === "function"
      ? checker.getStagedUpdate()
      : null;

  if (isPackaged && staged) {
    try {
      const dataBackupPath = createUpdateDataBackup(
        { ...getDataPaths(), dbPath: getDatabaseFilePath() },
        staged.version,
      );
      if (dataBackupPath) {
        log.info(`Backed up panel database before update: ${dataBackupPath}`);
        await setSetting("preUpdateDataBackupPath", dataBackupPath);
        await flushWrites();
      }
    } catch (backupErr) {
      log.warn(`Could not back up panel database before update: ${backupErr.message}`);
    }
  }

  if (isPackaged && isWindows && staged) {
    if (
      typeof checker.isSupervisorAvailable === "function" &&
      checker.isSupervisorAvailable()
    ) {
      try {
        if (checker.isApplying) {
          log.warn(
            "Supervisor restart-and-apply request rejected: another apply is in progress",
          );
          return res.status(409).json({
            error: "An update apply is already in progress.",
            code: "apply_in_progress",
          });
        }
        checker.isApplying = true;
        if (staged.version) {
          await setSetting("pendingPanelUpdate", staged.version);
          await flushWrites();
        }
        const markerPath = checker.writeSupervisorMarker(staged);
        log.info(
          `Staged update will be applied by supervisor (Start.bat v2). Marker: ${markerPath}`,
        );
        res.json({
          success: true,
          message: "Stopping panel for supervisor to apply update...",
          applyingUpdate: true,
          supervisor: true,
        });
        setTimeout(() => process.exit(75), 500);
        return;
      } catch (err) {
        log.error(`Could not write supervisor marker: ${err.message}`);
        return res.status(500).json({ error: sanitizeError(err.message) });
      }
    }

    checker.isApplying = false;
    return res.status(409).json({
      error:
        "This update requires the packaged Start.bat supervisor. Stop the panel and launch Start.bat, then apply again.",
    });
  }

  let linuxRespawnPath = null;
  if (isPackaged && !isWindows && staged) {
    if (checker.isApplying) {
      log.warn(
        "Linux restart-and-apply request rejected: another apply is in progress",
      );
      return res.status(409).json({
        error: "An update apply is already in progress.",
        code: "apply_in_progress",
      });
    }
    checker.isApplying = true;
    try {
      if (staged.version) {
        await setSetting("pendingPanelUpdate", staged.version);
        await flushWrites();
      }
      const appliedBundle = applyUpdateBundle(staged.journalPath);
      refreshInlineScriptCspHash();
      const targetPath = appliedBundle.paths.binary;
      try {
        await fs.promises.chmod(targetPath, 0o755);
      } catch (chmodErr) {
        log.warn(`Could not chmod new binary: ${chmodErr.message}`);
      }
      try {
        await fs.promises.access(targetPath, fs.constants.X_OK);
      } catch (accessErr) {
        recoverInterruptedUpdateBundle(
          staged.journalPath,
          "binary_not_executable",
        );
        refreshInlineScriptCspHash();
        checker.isApplying = false;
        log.error(
          `New binary at ${targetPath} is not executable: ${accessErr.message}`,
        );
        return res.status(500).json({
          error: sanitizeError(
            `Applied update is not executable: ${accessErr.message}`,
          ),
        });
      }
      linuxRespawnPath = targetPath;
      log.info(
        `Linux update bundle applied to ${targetPath}; awaiting startup acknowledgement after restart`,
      );
    } catch (err) {
      refreshInlineScriptCspHash();
      checker.isApplying = false;
      log.error(`Failed to apply Linux staged update: ${err.message}`);
      return res.status(500).json({ error: sanitizeError(err.message) });
    }
  }

  res.json({ success: true, message: "Panel is restarting..." });

  setTimeout(async () => {
    try {
      await flushWrites();
    } catch {
      /* best effort */
    }
    let orchestrated = false;
    const linuxSupervisor = isLinuxPanelSupervisor();
    if (isPackaged) {
      try {
        if (process.env.INVOCATION_ID || process.env.NOTIFY_SOCKET)
          orchestrated = true;
        if (
          fs.existsSync("/.dockerenv") ||
          fs.existsSync("/run/.containerenv")
        ) {
          orchestrated = true;
        }
      } catch {
        /* best effort */
      }

      if (!orchestrated && !linuxSupervisor) {
        const respawnTarget = linuxRespawnPath || process.execPath;
        spawn(respawnTarget, [], { detached: true, stdio: "ignore" }).unref();
      } else if (orchestrated) {
        log.info(
          "Running under orchestrator (systemd/Docker) — exiting for external restart",
        );
      } else {
        log.info(
          "Running under the Linux supervisor — exiting for start.sh to relaunch",
        );
      }
    }
    process.exit(linuxSupervisor ? 75 : orchestrated ? 1 : 0);
  }, 1000);
});

app.get("/api/panel/update-check", async (req, res) => {
  try {
    const checker = req.app.get("panelUpdateChecker");
    if (!checker)
      return res
        .status(500)
        .json({ error: "Panel update checker not available" });
    const status = await checker.checkForUpdate();
    res.json(status);
  } catch (error) {
    log.error(`Panel update check failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

app.get("/api/panel/update-status", (req, res) => {
  const checker = req.app.get("panelUpdateChecker");
  if (!checker)
    return res
      .status(500)
      .json({ error: "Panel update checker not available" });
  res.json(checker.getStatus());
});

app.get("/api/panel/update-preflight", async (req, res) => {
  try {
    const checker = req.app.get("panelUpdateChecker");
    if (!checker)
      return res
        .status(500)
        .json({ error: "Panel update checker not available" });
    const result = await checker.preflight();
    res.json(result);
  } catch (error) {
    log.error(`Panel update preflight failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

app.get("/api/panel/update-apply-log", (req, res) => {
  try {
    const checker = req.app.get("panelUpdateChecker");
    if (!checker)
      return res
        .status(500)
        .json({ error: "Panel update checker not available" });
    const log = checker.readMostRecentApplyLog();
    res.json({
      log,
      logPath: path.join(getDataPaths().logsDir, "panel-update-last.log"),
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export async function handlePanelUpdateDownload(req, res) {
    try {
      const checker = req.app.get("panelUpdateChecker");
      if (!checker)
        return res
          .status(500)
          .json({ error: "Panel update checker not available" });

      if (checker.dockerUpdateProxy?.enabled) {
        if (req.body?.confirm !== true) {
          return res.status(400).json({
            error:
              "Confirm the Docker update before recreating the all-in-one container.",
            code: "confirmation_required",
          });
        }

        const processDetails =
          typeof serverManager.getServerProcessDetails === "function"
            ? await serverManager.getServerProcessDetails()
            : null;
        if (!processDetails || processDetails.scanFailed) {
          return res.status(503).json({
            success: false,
            error:
              "Can't verify whether the server is stopped because process detection failed. The Docker update was not started.",
            code: ErrorCode.SERVER_STATE_UNKNOWN,
          });
        }
        const isRunning = Boolean(processDetails.running);
        if (isRunning) {
          const rconService = req.app.get("rconService");
          if (!rconService?.connected) {
            return res.status(409).json({
              error:
                "Stop the Project Zomboid server before applying a Docker update. RCON is not connected, so the panel cannot safely stop it for you.",
              code: ErrorCode.SERVER_RUNNING_RCON_UNAVAILABLE,
            });
          }

          const saved = await rconService.save();
          if (!saved?.success) {
            const reason = saved?.error || "unknown error";
            return res.status(409).json({
              error: `The world could not be saved (${reason}), so the server was left running. Applying the update now would lose everything since the last save.`,
              code: "save_failed",
              params: sanitizeErrorParams({ reason }),
            });
          }
          const quit = await rconService.quit();
          if (!quit?.success) {
            const reason = quit?.error || "unknown error";
            return res.status(502).json({
              error: `The world was saved, but the server could not be shut down (${reason}). It is still running, so the update was not applied.`,
              code: "stop_failed",
              params: sanitizeErrorParams({ reason }),
            });
          }
          await logServerEvent(
            "server_stop",
            "Server stopped before Docker panel update",
          );
        }
      }

      const result = await checker.downloadUpdate();
      if (!result.success) {
        if (result.code === "already_downloading")
          return res.status(409).json(result);
        if (result.code === "no_update") return res.status(400).json(result);
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error) {
      log.error(`Panel update download failed: ${error.message}`);
      res.status(500).json({ error: sanitizeError(error.message) });
    }
}

export function classifyStartupProcessState(processState, isRemote = false) {
  if (isRemote) {
    return { running: Boolean(processState?.running), unknown: false };
  }
  if (
    !processState ||
    processState.scanFailed ||
    typeof processState.running !== "boolean"
  ) {
    return { running: false, unknown: true };
  }
  return { running: processState.running, unknown: false };
}

app.post(
  "/api/panel/update-download",
  requireRole("admin"),
  handlePanelUpdateDownload,
);

const isPackaged = typeof process.pkg !== "undefined";
const clientDistPath = cspClientDistPath;
const legacyClientMetadata =
  isPackaged && !embeddedClientDistPath
    ? readClientDistMetadata(clientDistPath)
    : null;
const legacyClientMismatch =
  isPackaged &&
  !embeddedClientDistPath &&
  !clientDistMatchesMetadata(clientDistPath, _buildMetadata);

function buildLegacyClientRecoveryPage() {
  const escapeHtml = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const frontendMetadata = legacyClientMetadata || "unavailable";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Panel update required</title></head>
<body><main>
<h1>Panel update required</h1>
<p>The executable and web interface are from different releases.</p>
<p>Executable: ${escapeHtml(`${_buildMetadata.panelVersion} / ${_buildMetadata.buildSha.slice(0, 12)}`)}</p>
<p>Frontend: ${escapeHtml(typeof frontendMetadata === "string" ? frontendMetadata : `${frontendMetadata.panelVersion} / ${frontendMetadata.buildSha.slice(0, 12)}`)}</p>
<p>Download the latest full package, extract it over this installation without replacing the <code>data</code> folder, then start the panel again.</p>
<p><a href="https://github.com/itsmeares/better-zcp/releases/latest">Download the latest release</a></p>
</main></body>
</html>`;
}

if (legacyClientMismatch) {
  log.error(
    `Packaged frontend does not match executable ${_buildMetadata.panelVersion}/${_buildMetadata.buildSha}; serving recovery page instead of mixed client/dist`,
  );
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.status(503).type("html").send(buildLegacyClientRecoveryPage());
  });
}

log.debug(`Serving client from: ${clientDistPath}`);
if (!legacyClientMismatch) {
  app.use(
    express.static(clientDistPath, {
      maxAge: "7d",
      immutable: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );
}

export function sendClientIndex(res, clientDistPath, callback) {
  return res.sendFile("index.html", { root: clientDistPath }, callback);
}

// Global API error handler — sanitize internal details from error responses
const REGISTERED_ERROR_CODES = new Set(Object.values(ErrorCode));
export function apiErrorHandler(err, req, res, next) {
  log.error(`Unhandled API error on ${req.method} ${req.path}: ${err.message}`);
  const status = err.status || 500;
  const body = { error: sanitizeError(err.message) };
  if (typeof err.code === "string" && REGISTERED_ERROR_CODES.has(err.code)) {
    body.code = err.code;
  }
  res.status(status).json(body);
}
app.use("/api", apiErrorHandler);

app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api")) {
    res.status(404).json({ error: "API endpoint not found" });
  } else {
    sendClientIndex(res, clientDistPath, (err) => {
      if (err) {
        log.error(`Failed to serve index.html: ${err.message}`);
        res.status(500).send("Page not available");
      }
    });
  }
});

io.use(async (socket, next) => {
  try {
    const needsSetup = await authService.needsSetup();
    if (needsSetup) return next();

    const authEnabled = await authService.isAuthEnabled();
    if (!authEnabled) {
      socket.user = {
        userId: null,
        username: null,
        role: "admin",
        tokenGen: null,
        authDisabled: true,
      };
      return next();
    }

    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      return next(new Error("Authentication required"));
    }

    const payload = await authService.authenticateAccessToken(token);
    if (!payload) {
      return next(new Error("Invalid or expired token"));
    }

    socket.user = payload;
    next();
  } catch (error) {
    next(new Error("Authentication error"));
  }
});

export async function socketHasCapability(socket, capability) {
  if (!socket.user) return false;
  try {
    const role = await getRoleByName(socket.user.role);
    return Array.isArray(role?.capabilities) && role.capabilities.includes(capability);
  } catch (error) {
    log.warn(`Could not resolve socket capability "${capability}": ${error.message}`);
    return false;
  }
}

io.on("connection", (socket) => {
  log.debug(
    `Client connected: ${socket.id}${socket.user ? ` (${socket.user.username})` : ""}`,
  );

  socket.on("disconnect", () => {
    log.debug(`Client disconnected: ${socket.id}`);
  });

  socket.on("subscribe:status", () => {
    socket.join("server-status");
  });

  socket.on("subscribe:players", async () => {
    if (!(await socketHasCapability(socket, "players.view"))) return;
    socket.join("players");
  });

  socket.on("subscribe:logs", async () => {
    if (!(await socketHasCapability(socket, "diagnostics.manage"))) return;
    socket.join("logs");
  });

  socket.on("subscribe:perf", async () => {
    if (!(await socketHasCapability(socket, "diagnostics.manage"))) return;
    socket.join("perf");
  });
  socket.on("unsubscribe:perf", () => {
    socket.leave("perf");
  });

  socket.on("subscribe:rcon", async () => {
    if (!(await socketHasCapability(socket, "rcon.execute"))) return;
    socket.join("rcon-live");
  });
});

onLog((logEntry) => {
  addLogToBuffer(logEntry.level, logEntry.message, logEntry.source);
  io.to("logs").emit("log:entry", logEntry);
});

import { getDataPaths } from "./utils/paths.js";

async function autoExportPlayer(username) {
  try {
    if (!panelBridge.isRunning || !panelBridge.isModConnected()) {
      log.debug(
        `Auto-export skipped for ${username}: PanelBridge not connected`,
      );
      return;
    }
    const result = await panelBridge.sendCommand("exportPlayerData", {
      username,
    });
    if (!result || !result.success) {
      log.warn(
        `Auto-export failed for ${username}: ${result?.error || "unknown error"}`,
      );
      return;
    }

    const { dataDir } = getDataPaths();
    const exportDir = path.join(
      dataDir,
      "exports",
      username.replace(/[^a-zA-Z0-9_-]/g, "_"),
    );
    fs.mkdirSync(exportDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${username.replace(/[^a-zA-Z0-9_-]/g, "_")}_${timestamp}.json`;
    fs.writeFileSync(
      path.join(exportDir, filename),
      JSON.stringify(result.data || result, null, 2),
    );

    const maxExports = Number(await getSetting("autoExportMaxPerPlayer")) || 3;
    const files = fs
      .readdirSync(exportDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();

    if (files.length > maxExports) {
      for (const old of files.slice(maxExports)) {
        fs.unlinkSync(path.join(exportDir, old));
      }
    }

    log.info(
      `Auto-exported character data for ${username} (${files.length > maxExports ? maxExports : files.length} kept)`,
    );
  } catch (err) {
    log.warn(`Auto-export error for ${username}: ${err.message}`);
  }
}

let lastPlayerList = [];
let playerBaselineReady = false;
let playerPollingInterval = null;
let rconConnectedAt = 0;

function startPlayerPolling() {
  if (playerPollingInterval) {
    clearInterval(playerPollingInterval);
  }
  lastPlayerList = [];
  playerBaselineReady = false;

  playerPollingInterval = setInterval(async () => {
    try {
      if (!rconService.connected) {
        return;
      }

      if (rconConnectedAt && Date.now() - rconConnectedAt < 15000) {
        return;
      }

      const result = await rconService.getPlayers();
      if (result.success && result.players) {
        const baselineWasReady = playerBaselineReady;
        playerBaselineReady = true;

        const currentNames = result.players
          .map((p) => p.name)
          .sort()
          .join(",");
        const lastNames = lastPlayerList
          .map((p) => p.name)
          .sort()
          .join(",");

        if (currentNames !== lastNames) {
          const currentSet = new Set(result.players.map((p) => p.name));
          const lastSet = new Set(lastPlayerList.map((p) => p.name));
          const joined = result.players.filter((p) => !lastSet.has(p.name));
          const left = lastPlayerList.filter((p) => !currentSet.has(p.name));

          lastPlayerList = result.players;
          io.to("players").emit("players:update", result.players);
          log.debug(
            `Player list updated: ${result.players.length} players online`,
          );

          if (baselineWasReady && !panelBridge.modStatus?.alive) {
            for (const p of joined) {
              discordBot
                .sendEventNotification("playerJoin", { player: p.name })
                .catch((err) =>
                  log.debug(
                    `Discord playerJoin notification failed: ${err.message}`,
                  ),
                );
            }
            for (const p of left) {
              discordBot
                .sendEventNotification("playerLeave", { player: p.name })
                .catch((err) =>
                  log.debug(
                    `Discord playerLeave notification failed: ${err.message}`,
                  ),
                );
            }

            const autoExport = await getSetting("autoExportOnLogin");
            if (autoExport === true || autoExport === "true") {
              for (const p of joined) {
                setTimeout(() => autoExportPlayer(p.name), 10000);
              }
            }
          }
        }
      }
    } catch (error) {
      log.debug(`Player polling error: ${error.message}`);
    }
  }, 5000);
  if (playerPollingInterval.unref) playerPollingInterval.unref();

  log.info("Server-side player polling started (5s interval)");
}

function stopPlayerPolling() {
  if (playerPollingInterval) {
    clearInterval(playerPollingInterval);
    playerPollingInterval = null;
    log.info("Server-side player polling stopped");
  }
}

let perfPollingInterval = null;
let lastCpuInfo = null;

function getCpuUsage() {
  const cpus = os.cpus();
  const total = cpus.reduce(
    (acc, cpu) => {
      const t = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle;
      return { total: acc.total + t, idle: acc.idle + idle };
    },
    { total: 0, idle: 0 },
  );

  if (!lastCpuInfo) {
    lastCpuInfo = total;
    return 0;
  }

  const totalDiff = total.total - lastCpuInfo.total;
  const idleDiff = total.idle - lastCpuInfo.idle;
  lastCpuInfo = total;
  return totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
}

let lastDiskSample = { at: 0, value: null };
const DISK_SAMPLE_INTERVAL_MS = 60000;

async function getDiskSnapshot() {
  const now = Date.now();
  if (now - lastDiskSample.at < DISK_SAMPLE_INTERVAL_MS) {
    return lastDiskSample.value;
  }
  lastDiskSample.at = now;
  try {
    const activeServer = await getActiveServer();
    const target =
      activeServer?.zomboidDataPath ||
      activeServer?.installPath ||
      getDataPaths().dataDir;
    const disk = await getDiskFree(target);
    lastDiskSample.value =
      disk && disk.total > 0
        ? { total: disk.total, used: disk.total - disk.free }
        : null;
  } catch {
    lastDiskSample.value = null;
  }
  return lastDiskSample.value;
}

let lastSwapSample = { at: 0, value: null };
const SWAP_SAMPLE_INTERVAL_MS = 60000;

async function getSwapSnapshot() {
  const now = Date.now();
  if (now - lastSwapSample.at < SWAP_SAMPLE_INTERVAL_MS) {
    return lastSwapSample.value;
  }
  lastSwapSample.at = now;
  try {
    lastSwapSample.value = await getSwapInfo();
  } catch {
    lastSwapSample.value = null;
  }
  return lastSwapSample.value;
}

async function getPzProcessMemory() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 5000);

    if (process.platform === "win32") {
      exec(
        'powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'java.exe\'\\" | Select-Object ProcessId, WorkingSetSize, CommandLine | Format-List"',
        { timeout: 8000 },
        (err, stdout) => {
          clearTimeout(timeout);
          if (err || !stdout) return resolve(null);

          const blocks = stdout
            .split(/ProcessId/)
            .filter((b) =>
              b.toLowerCase().includes("zombie.network.gameserver"),
            );
          if (blocks.length === 0) return resolve(null);

          const wsMatch = blocks[0].match(/WorkingSetSize\s*:\s*(\d+)/i);
          if (!wsMatch) return resolve(null);

          resolve(parseInt(wsMatch[1], 10));
        },
      );
    } else {
      exec(
        'ps aux --no-headers | grep -i "zombie.network.[Gg]ame[Ss]erver" | grep -v grep',
        { timeout: 5000 },
        (err, stdout) => {
          clearTimeout(timeout);
          if (err || !stdout || !stdout.trim()) return resolve(null);

          const parts = stdout.trim().split(/\s+/);
          if (parts.length >= 6) {
            const rssKB = parseInt(parts[5], 10);
            if (!isNaN(rssKB)) return resolve(rssKB * 1024);
          }
          resolve(null);
        },
      );
    }
  });
}

async function startPerfPolling() {
  if (perfPollingInterval) clearInterval(perfPollingInterval);


  getCpuUsage();

  perfPollingInterval = setInterval(async () => {
    try {
      const hostMem = os.totalmem();
      const hostMemFree = os.freemem();
      const cpuUsage = getCpuUsage();
      const panelMem = process.memoryUsage();

      const pzMemBytes = await getPzProcessMemory();
      const disk = await getDiskSnapshot();
      const swap = await getSwapSnapshot();

      const snapshot = {
        hostMemTotal: hostMem,
        hostMemUsed: hostMem - hostMemFree,
        cpuUsage,
        hostDiskTotal: disk?.total ?? null,
        hostDiskUsed: disk?.used ?? null,
        hostSwapTotal: swap?.total ?? null,
        hostSwapUsed: swap?.used ?? null,
        panelMemHeap: panelMem.heapUsed,
        panelMemRss: panelMem.rss,
        pzMemUsed: pzMemBytes,
        memoryUsed: panelMem.heapUsed,
        memoryTotal: panelMem.heapTotal,
        playerCount: lastPlayerList.length,
        serverRunning: serverManager.isRunning,
      };

      await recordPerformanceSnapshot(snapshot);

      io.to("perf").emit("perf:snapshot", snapshot);
    } catch (err) {
      log.debug(`Perf snapshot failed: ${err.message}`);
    }
  }, 60000);

  if (perfPollingInterval.unref) perfPollingInterval.unref();
  log.info("Performance polling started (60s interval)");
}

function stopPerfPolling() {
  if (perfPollingInterval) {
    clearInterval(perfPollingInterval);
    perfPollingInterval = null;
  }
}

let statusWatchdogInterval = null;
let lastKnownRunning = null;

export async function getObservedServerRunning() {
  return resolveObservedServerRunning(serverManager, rconService, dockerClient);
}

export async function checkServerStatusNow(detectionReason = "watchdog") {
  try {
    const running = await getObservedServerRunning();
    if (running === null) {
      log.debug("Status watchdog: server state is unknown; skipping transition");
      return;
    }
    if (lastKnownRunning !== null && running !== lastKnownRunning) {
      log.info(
        `Server state changed → ${running ? "running" : "stopped"} (detected by ${detectionReason})`,
      );
      io.emit("server:status", { running });
      if (!running) {
        logServerEvent(
          "server_stop",
          `Server process exited (detected by ${detectionReason})`,
        );
        discordBot
          .sendEventNotification("serverStop", {})
          .catch((err) =>
            log.debug(
              `Discord serverStop notification failed: ${err.message}`,
            ),
          );
      } else {
        discordBot
          .sendEventNotification("serverStart", {})
          .catch((err) =>
            log.debug(
              `Discord serverStart notification failed: ${err.message}`,
            ),
          );
      }
    }
    lastKnownRunning = running;
  } catch (err) {
    log.debug(`Status watchdog error: ${err.message}`);
  }
}

function startStatusWatchdog() {
  if (statusWatchdogInterval) clearInterval(statusWatchdogInterval);
  statusWatchdogInterval = setInterval(checkServerStatusNow, 10000);
  if (statusWatchdogInterval.unref) statusWatchdogInterval.unref();
  log.info("Server status watchdog started (10s interval)");
}

export async function probeRconFallbackIfConfigured(
  activeServer,
  rconServiceInstance,
  timeoutMs,
) {
  if (!activeServer) {
    log.debug(
      "No server configured yet — skipping RCON port fallback probe",
    );
    return false;
  }

  let rconPortOccupied = false;
  try {
    await rconServiceInstance.loadConfig();
    const rconHost = rconServiceInstance.config.host || "127.0.0.1";
    const rconPort = rconServiceInstance.config.port || 27015;
    const portOpen = await rconServiceInstance.checkPortOpen(
      rconHost,
      rconPort,
    );
    if (portOpen) {
      rconPortOccupied = true;
      log.info(
        `RCON port ${rconHost}:${rconPort} is open even though process check failed — connecting...`,
      );
      try {
        await Promise.race([
          rconServiceInstance.connect(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("RCON connection timeout")),
              timeoutMs,
            ),
          ),
        ]);
        if (rconServiceInstance.connected) {
          log.info("RCON connected via port fallback probe");
        }
      } catch (e) {
        log.debug(`Fallback RCON connect failed: ${e.message}`);
      }
    }
  } catch (e) {
    log.debug(`Fallback RCON probe error: ${e.message}`);
  }
  return rconPortOccupied;
}

export async function logExposureWarningIfNeeded({
  needsSetup,
  boundPort,
  localIp,
  authServiceInstance = authService,
  loggerInstance = log,
}) {
  const reachableUrl =
    localIp && localIp !== "127.0.0.1"
      ? `http://${localIp}:${boundPort}`
      : `http://<this-machine>:${boundPort}`;

  if (needsSetup) {
    loggerInstance.warn(
      "SECURITY: no admin account exists yet. Every API route is open to " +
        `anyone who can reach ${reachableUrl} until first-run setup completes. ` +
        "If this port reaches the internet, complete setup immediately or " +
        "block the port at your firewall/router until you have.",
    );
    return;
  }

  const authEnabled = await authServiceInstance.isAuthEnabled();
  if (!authEnabled) {
    loggerInstance.warn(
      "SECURITY: authentication is disabled. Every API route is open to " +
        `anyone who can reach ${reachableUrl}. Re-enable authentication ` +
        "before exposing this port beyond a trusted LAN.",
    );
  }
}

async function start() {
  try {
    let panelVersion;
    try {
      panelVersion =
        typeof PANEL_VERSION !== "undefined"
          ? PANEL_VERSION
          : JSON.parse(
              fs.readFileSync(path.join(__dirname, "../../package.json"), "utf-8"),
            ).version;
    } catch {
      panelVersion = "0.0.0";
    }
    logBanner(panelVersion);

    if (typeof process.pkg !== "undefined") {
      try {
        _pendingUpdateInspection = inspectPendingPanelUpdate();
      } catch (error) {
        log.error(
          `Update startup validation failed [${error.code || "invalid_bundle"}]: ${error.message}`,
        );
        process.exit(76);
        return;
      }
    }

    try {
      const { acquireLock } = await import("./utils/pidLock.ts");
      const { getDataPaths } = await import("./utils/paths.js");
      const { dataDir } = getDataPaths();
      const lockResult = acquireLock(dataDir);
      if (!lockResult.acquired) {
        log.error(`Refusing to start: ${lockResult.reason}.`);
        log.error(
          `If you're sure no other panel is running, delete ${lockResult.lockPath} and try again.`,
        );
        process.exit(78);
      }
    } catch (err) {
      log.warn(`Lock check skipped: ${err.message}`);
    }

    logSection("Database");
    await initDatabase();
    await refreshCorsConfig();
    log.info("Database ready");

    await authService.init();

    if (process.argv.includes("--reset-password")) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

      let users;
      try {
        users = await authService.getUsers();
      } catch (err) {
        console.log(`\n  ERROR: Could not read users: ${err.message}\n`);
        rl.close();
        process.exit(1);
      }

      if (users.length === 0) {
        console.log(
          "\n  No user accounts exist. Start the panel normally to run setup.\n",
        );
        rl.close();
        process.exit(0);
      }

      console.log("\n  ╔══════════════════════════════════════╗");
      console.log("  ║     Password Reset (CLI Mode)        ║");
      console.log("  ╚══════════════════════════════════════╝");
      console.log(`\n  Admin account: ${users[0].username}`);
      const newPassword = await ask("  Enter new password (min 6 chars): ");

      if (!newPassword || newPassword.length < 6) {
        console.log("  ERROR: Password must be at least 6 characters.\n");
        rl.close();
        process.exit(1);
      }

      if (newPassword.length > 128) {
        console.log("  ERROR: Password must be 128 characters or fewer.\n");
        rl.close();
        process.exit(1);
      }

      const confirm = await ask("  Confirm new password: ");
      if (newPassword !== confirm) {
        console.log("  ERROR: Passwords do not match.\n");
        rl.close();
        process.exit(1);
      }

      try {
        const result = await authService.resetPassword(newPassword);
        console.log(`\n  Password reset successful for: ${result.username}`);
        console.log("  All existing sessions have been invalidated.\n");
      } catch (err) {
        console.log(`  ERROR: ${err.message}\n`);
        rl.close();
        process.exit(1);
      }

      rl.close();
      process.exit(0);
    }

    const needsSetup = await authService.needsSetup();
    if (needsSetup) {
      log.info("No users found — first-run setup required");
    } else {
      const authEnabled = await authService.isAuthEnabled();
      log.info(`Authentication: ${authEnabled ? "enabled" : "disabled"}`);
    }

    logSection("Services");

    await logTailer.init();

    let chatMessageSeq = 0;
    logTailer.on("chatMessage", (data) => {
      io.emit("chat:message", {
        id: `${Date.now()}-${chatMessageSeq++}`,
        type: data.type || "general",
        author: data.author,
        message: data.message,
        timestamp: data.timestamp,
      });
    });

    logTailer.on("playerDeath", async (data) => {
      try {
        const { logPlayerAction } = await import("./database/init.js");
        logPlayerAction(
          data.player,
          "death",
          `${data.pvp ? "PvP" : "non-pvp"} death at (${data.location})`,
        ).catch((err) =>
          log.debug(`Failed to log player death: ${err.message}`),
        );
      } catch (err) {
        log.debug(`playerDeath DB log failed: ${err.message}`);
      }
      discordBot
        .sendEventNotification("playerDeath", {
          player: data.player,
          x: String(data.x),
          y: String(data.y),
          z: String(data.z),
          location: data.location,
          pvp: data.pvp ? "PvP" : "non-pvp",
        })
        .catch((err) =>
          log.debug(`Discord playerDeath notification failed: ${err.message}`),
        );
      io.emit("player:death", data);
    });

    await scheduler.init();

    await modChecker.init(scheduler, serverManager, io);

    if (modChecker.workshopAcfPath) {
      modChecker.start();
    } else {
      log.info(
        "Mod checker: Workshop ACF not found — configure server install path",
      );
    }

    await discordBot.loadConfig();
    const discordAutoStart = await getSetting("discordAutoStart");
    if (discordBot.token && discordBot.guildId && discordAutoStart !== false) {
      await discordBot.start();
    } else if (
      discordBot.token &&
      discordBot.guildId &&
      discordAutoStart === false
    ) {
      log.info("Discord bot configured but auto-start is disabled");
    }

    logSection("Server Detection");

    (async () => {
      try {
        await new Promise((r) => setTimeout(r, 1000));

        const bridgeStarted = await tryStartPanelBridge("startup");
        if (bridgeStarted) {
          log.info(
            "PanelBridge started on startup (found active bridge files)",
          );
        }

        const timeoutMs = 15000;
        const activeServer = await getActiveServer();
        const processState = await Promise.race([
          activeServer?.isRemote
            ? Promise.resolve({
                running: rconService.connected || panelBridge.isModConnected(),
                scanFailed: false,
              })
            : serverManager.getServerProcessDetails(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Server check timeout")),
              timeoutMs,
            ),
          ),
        ]);
        const startupState = classifyStartupProcessState(
          processState,
          Boolean(activeServer?.isRemote),
        );
        const processStateUnknown = startupState.unknown;
        const isRunning = startupState.running;

        if (isRunning || processStateUnknown) {
          log.info(
            processStateUnknown
              ? "PZ server process state is unknown - trying RCON but will not auto-start"
              : "PZ server detected running - connecting RCON...",
          );

          let connected = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await Promise.race([
                rconService.connect(),
                new Promise((_, reject) =>
                  setTimeout(
                    () => reject(new Error("RCON connection timeout")),
                    timeoutMs,
                  ),
                ),
              ]);

              if (rconService.connected) {
                connected = true;
                log.info(`RCON connected on attempt ${attempt}`);
                break;
              }
            } catch (e) {
              log.debug(
                `RCON connection attempt ${attempt} failed: ${e.message}`,
              );
              if (attempt < 3) {
                await new Promise((r) => setTimeout(r, 5000));
              }
            }
          }

          if (!connected) {
            log.warn(
              "RCON connection failed after 3 attempts - auto-reconnect will keep trying",
            );
          }
        } else {
          log.info("PZ server not detected running on startup");

          const rconPortOccupied = await probeRconFallbackIfConfigured(
            activeServer,
            rconService,
            timeoutMs,
          );

          const autoStartServer = await getSetting("autoStartServer");
          if (autoStartServer === true || autoStartServer === "true") {
            if (rconPortOccupied) {
              log.warn(
                "Auto-start SKIPPED: RCON port is already occupied — a PZ server is likely running but process detection failed. Will keep retrying RCON connection.",
              );
              rconService.setServerStarting(false);
            } else {
              const lifecycleLock = acquireLifecycleLock(
                "startup-auto-start",
                activeServer?.name || activeServer?.serverName || null,
              );
              if (!lifecycleLock) {
                log.warn(
                  "Auto-start skipped because another lifecycle operation is in progress",
                );
                rconService.setServerStarting(false);
              } else {
                log.info("Auto-start is enabled - starting PZ server...");

                rconService.setServerStarting(true);

                try {
                  const startResult = await serverManager.startServer({
                    serverId: activeServer?.id ?? null,
                  });
                  if (startResult.success) {
                    log.info("PZ server auto-started successfully");

                    log.info("PZ server auto-started - Monitoring RCON port...");

                    await rconService.loadConfig();
                    const rconHost = rconService.config.host || "127.0.0.1";
                    const rconPort = rconService.config.port || 27015;

                    const maxPollAttempts = 60;

                    for (let i = 0; i < maxPollAttempts; i++) {
                      const portOpen = await rconService.checkPortOpen(
                        rconHost,
                        rconPort,
                      );

                      if (!portOpen) {
                        if (i % 6 === 0) {
                          log.debug(
                            `Auto-start: Waiting for RCON port ${rconHost}:${rconPort}...`,
                          );
                        }
                        await new Promise((r) => setTimeout(r, 5000));
                        continue;
                      }

                      log.info(`RCON port open! Attempting connection...`);

                      try {
                        await Promise.race([
                          rconService.connect(),
                          new Promise((_, reject) =>
                            setTimeout(
                              () => reject(new Error("RCON connection timeout")),
                              15000,
                            ),
                          ),
                        ]);

                        if (rconService.connected) {
                          log.info(
                            "RCON connected successfully after auto-start",
                          );
                          break;
                        } else {
                          log.debug(
                            "RCON port open but connection failed, retrying in 5s...",
                          );
                          await new Promise((r) => setTimeout(r, 5000));
                        }
                      } catch (e) {
                        log.debug(
                          `Auto-start RCON connection failed: ${e.message}`,
                        );
                        await new Promise((r) => setTimeout(r, 5000));
                      }
                    }
                  } else {
                    log.error(
                      "Failed to auto-start PZ server:",
                      startResult.error,
                    );
                  }
                } catch (e) {
                  log.error("Error during auto-start:", e.message);
                } finally {
                  rconService.setServerStarting(false);
                  lifecycleLock.release();
                }
              }
            }
          }

          // Even if server isn't running, Panel Bridge might have stale files
          // The bridge will detect the mod isn't responding via status timestamp
        }
      } catch (e) {
        log.debug(`Startup initialization: ${e.message}`);
      }
    })();

    startPlayerPolling();

    startPerfPolling();

    startStatusWatchdog();

    updateChecker.start();

    panelUpdateChecker.start(_pkgVersion);

    diskMonitor.start();

    const savedPort = await getSetting("panelPort");
    const configuredPort = Number(process.env.PORT || savedPort || 3001);
    const PORT = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
      ? configuredPort
      : 3001;
    let listenPort = PORT;

    const httpsEnabled = await getSetting("httpsEnabled");
    const httpsPort = (await getSetting("httpsPort")) || 3443;
    const customKeyPath = await getSetting("httpsKeyPath");
    const customCertPath = await getSetting("httpsCertPath");

    setupHttpsServer({ httpsEnabled, httpsPort, customKeyPath, customCertPath });

    let listenRetries = 0;
    const maxListenRetries = 5;
    const listenWithRetry = () => {
      httpServer.listen(listenPort, async () => {
        const address = httpServer.address();
        const boundPort = address && typeof address === "object" ? address.port : listenPort;
        activePanelPort = boundPort;
        if (listenPort === 0 && !process.env.PORT && boundPort !== PORT) {
          await setSetting("panelPort", boundPort);
          await flushWrites();
          log.warn(`Configured panel port ${PORT} was unavailable; switched to free port ${boundPort} and saved it.`);
        }
        logSection("Ready");
        const urls = [{ label: "Local: ", url: `http://localhost:${boundPort}` }];
        if (httpsServer) {
          urls.push({
            label: "HTTPS: ",
            url: `https://localhost:${httpsPort}`,
          });
        }

        const localIp = await serverManager.getLocalIp();
        if (localIp !== "127.0.0.1") {
          urls.push({
            label: "Network:",
            url: `http://${localIp}:${boundPort}`,
          });
        }
        logReady(urls);
        try {
          const journalPath = updateBundleJournalPath();
          if (
            _pendingUpdateInspection.awaitingStartupAck &&
            acknowledgeUpdateBundle(journalPath, _buildMetadata, {
              transactionId: _pendingUpdateInspection.transactionId,
              expectedMetadata: _pendingUpdateInspection.metadata,
              applyingMarkerPath: _pendingUpdateInspection.applyingMarkerPath,
            })
          ) {
            log.info("Update bundle startup acknowledged; previous artifacts removed");
            await setSetting("preUpdateDataBackupPath", null);
            await flushWrites();

            if (process.platform !== "win32") {
              const linuxExeDir = path.dirname(process.execPath);
              try {
                const activated =
                  panelUpdateChecker.activateStagedLinuxLauncherFiles(linuxExeDir);
                if (activated) {
                  log.info(
                    "Linux launcher and service templates updated; re-run install-linux-service.sh --enable to load the new unit.",
                  );
                }
              } catch (activateErr) {
                log.error(
                  `Could not update Linux launcher/service templates: ${activateErr.message}. ` +
                    `Run: sudo ${path.join(linuxExeDir, "install-linux-service.sh")} --enable`,
                );
              }
            }
          }
        } catch (error) {
          log.error(
            `Update startup handshake failed [${error.code || "startup_handshake_failed"}]: ${error.message}`,
          );
          if (error.code === "version_mismatch") {
            refreshInlineScriptCspHash();
            try {
              const backupPath = await getSetting("preUpdateDataBackupPath");
              closeDatabase();
              if (
                restorePreUpdateDataBackup(
                  { ...getDataPaths(), dbPath: getDatabaseFilePath() },
                  backupPath,
                )
              ) {
                log.warn(
                  `Restored the pre-update database snapshot after a version-mismatch rollback: ${backupPath}`,
                );
              } else {
                log.error(
                  "Version-mismatch rollback occurred but no pre-update database snapshot was recorded to restore.",
                );
              }
            } catch (restoreErr) {
              log.error(
                `Could not restore the pre-update database snapshot: ${restoreErr.message}`,
              );
            }
          }
          process.exitCode = 76;
          setImmediate(() => process.exit(76));
          return;
        }
        await logExposureWarningIfNeeded({ needsSetup, boundPort, localIp });
        await logSetupTokenIfNeeded(needsSetup);

        try {
          const existingServers = await getServers();
          if (!existingServers || existingServers.length === 0) {
            const mounts = discoverMounts();
            if (mounts.length > 0) {
              log.info(
                `PZ server files detected at ${mounts[0].installPath} — visit Settings to connect`,
              );
            }
          }
        } catch (err) {
          log.debug(`Mount auto-discovery check failed: ${err.message}`);
        }

        if (process.platform !== "win32") {
          if (process.getuid && process.getuid() === 0) {
            log.warn(
              "Running as root is not recommended. Create a dedicated user: useradd -r -m pzuser",
            );
          }
          try {
            const maxWatches = fs
              .readFileSync("/proc/sys/fs/inotify/max_user_watches", "utf8")
              .trim();
            if (parseInt(maxWatches, 10) < 65536) {
              log.warn(
                `Low inotify limit (${maxWatches}). File watching may fail. Fix: sudo sysctl -w fs.inotify.max_user_watches=524288`,
              );
            }
          } catch (e) {
            log.debug(`inotify check skipped: ${e.message}`);
          }
          try {
            const lddOut = execSync("ldd --version 2>&1 || true", {
              encoding: "utf8",
              timeout: 5000,
            });
            const glibcMatch = lddOut.match(/(\d+)\.(\d+)/);
            if (glibcMatch) {
              const major = parseInt(glibcMatch[1], 10);
              const minor = parseInt(glibcMatch[2], 10);
              if (major < 2 || (major === 2 && minor < 28)) {
                log.warn(
                  `glibc ${major}.${minor} detected — panel requires glibc 2.28+. CentOS 7 is not supported, use CentOS Stream 8+ or Docker.`,
                );
              } else {
                log.info(`glibc ${major}.${minor} detected`);
              }
            }
          } catch (e) {
            log.debug(`glibc version check skipped: ${e.message}`);
          }
          if (!fs.existsSync("/proc/self/status")) {
            log.warn(
              "/proc not fully available — process detection may be limited (containerized environment?)",
            );
          }
          try {
            if (
              !fs.existsSync("/lib/ld-linux.so.2") &&
              !fs.existsSync("/usr/lib/ld-linux.so.2")
            ) {
              log.warn(
                "32-bit glibc not found (ld-linux.so.2). SteamCMD requires: sudo yum install glibc.i686 libstdc++.i686 (CentOS) or sudo dpkg --add-architecture i386 && sudo apt install lib32gcc-s1 (Ubuntu)",
              );
            }
          } catch (e) {
            log.debug(`32-bit libs check skipped: ${e.message}`);
          }
        }

        if (typeof process.pkg !== "undefined" && shouldAutoOpenBrowser()) {
          const protocol = httpsServer ? "https" : "http";
          const url = `${protocol}://localhost:${httpsServer ? httpsPort : boundPort}`;

          if (
            process.platform !== "win32" &&
            process.platform !== "darwin" &&
            !process.env.DISPLAY &&
            !process.env.WAYLAND_DISPLAY
          ) {
            log.debug(
              `Panel running at ${url} (no display detected — skipping browser open)`,
            );
          } else {
            const openCmd =
              process.platform === "win32"
                ? `start "" "${url}"`
                : process.platform === "darwin"
                  ? `open "${url}"`
                  : `xdg-open "${url}"`;
            exec(openCmd, (err) => {
              if (err) log.error("Failed to open browser:", err);
            });
          }
        }
      });
    };

    httpServer.on("error", (err) => {
      if (err.code === "EADDRINUSE" && listenRetries < maxListenRetries) {
        listenRetries++;
        const delay = Math.min(1000 * listenRetries, 4000);
        log.warn(
          `Port ${PORT} busy, retrying in ${delay}ms (attempt ${listenRetries}/${maxListenRetries})...`,
        );
        setTimeout(listenWithRetry, delay);
      } else if (err.code === "EADDRINUSE") {
        if (!process.env.PORT) {
          listenRetries = 0;
          listenPort = 0;
          log.warn(
            `Port ${PORT} remained unavailable after ${maxListenRetries} retries; selecting a free port automatically.`,
          );
          setTimeout(listenWithRetry, 0);
          return;
        }
        log.error(`Port ${PORT} is in use and PORT is explicitly set; refusing to choose a different port.`);
        log.error(`Find the offender with: ${process.platform === "win32" ? `netstat -ano | findstr :${PORT}` : `ss -tlnp | grep :${PORT}  (or: lsof -i :${PORT})`}`);
        process.exit(1);
      } else {
        log.error(`Server error: ${err.message}`);
        process.exit(1);
      }
    });

    listenWithRetry();
  } catch (error) {
    log.error("Failed to start server:", error);
    process.exit(1);
  }
}

if (!process.env.VITEST) {
  start();
}

export { io };
