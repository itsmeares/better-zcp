import "./utils/firstRunOwnershipCheck.ts";
import { logSetupTokenIfNeeded } from "./utils/setupToken.ts";
import { computeInlineScriptCspHashes } from "./utils/cspScriptHash.ts";
import { parseTrustProxySetting } from "./utils/trustProxy.ts";
import { normalizeOrigin, parseOriginList } from "./utils/corsOrigins.ts";
import { createServer } from "http";
import { Server } from "socket.io";
import type { Socket } from "socket.io";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import os from "os";
import { resolvePanelLocalIp } from "./utils/panelInfo.ts";
import readline from "readline";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { exec, execSync, spawn } from "child_process";

import {
  onLog,
  createLogger,
  logSection,
  logBanner,
  logReady,
} from "./utils/logger.ts";
import { setPanelRuntime, getServerRuntimes } from "./utils/panelRuntime.ts";
const log = createLogger("Panel");

type AnyRecord = Record<string, any>;
type PlayerRecord = AnyRecord & { name: string };
type SwapSnapshot = { total: number; used: number };
type AuthenticatedSocket = Socket & { user?: AnyRecord };
type CorsBlockedOrigin = {
  id: string;
  origin: string;
  source: string;
  blockedAt: string;
};
type CorsState = {
  allowAll: boolean;
  allowPrivateNetworks: boolean;
  debug: boolean;
  customOrigins: Set<string>;
  blocked: CorsBlockedOrigin[];
  lastLoadedAt: string | null;
};
import {
  initDatabase,
  getCurrentServer,
  getAllSettings,
  getServers,
  getServer,
  getSetting,
  setSetting,
  closeDatabase,
  recordPerformanceSnapshot,
  logServerEvent,
  getDatabaseFilePath,
} from "./database/init.ts";
import { RconService } from "./services/rcon.ts";
import { ServerManager } from "./services/serverManager.ts";
import { DockerClient } from "./services/dockerClient.ts";
import { setDockerClient } from "./services/managedContainer.ts";
import { ModChecker, refreshWorkshopChecker } from "./services/modChecker.ts";
import { Scheduler } from "./services/scheduler.ts";
import { BackupService } from "./services/backupService.ts";
import { UpdateChecker } from "./services/updateChecker.ts";
import { PanelUpdateChecker } from "./services/panelUpdateChecker.ts";
import {
  PANEL_API_CONTRACT_VERSION as DEFAULT_API_CONTRACT_VERSION,
} from "./services/updateBundle.ts";
import { LogTailer } from "./services/logTailer.ts";
import { DiskMonitor } from "./services/diskMonitor.ts";
import authService, {
  onSessionRevoked,
  type SessionRevocationEvent,
} from "./services/auth.ts";
import { createPanelRequestHandler } from "./http/panelWeb.ts";
export {
  handlePanelUpdateDownload,
  handlePanelUpdateStatus,
} from "./http/panelUpdateHandlers.ts";
import { resolvePanelPort } from "./utils/panelInfo.ts";
import {
  getEmbeddedClientDistPath,
  resolveClientDistPath,
} from "./utils/embeddedClient.ts";
import { resolveObservedServerRunning } from "./utils/serverStatus.ts";
import { discoverMounts } from "./services/mountDiscovery.ts";
import { buildPanelHealthPayload } from "./utils/panelHealth.ts";
import { shouldAutoOpenBrowser } from "./utils/browserLaunch.ts";
import { acquireLifecycleLock } from "./services/lifecycleCoordinator.ts";


process.stdout?.on?.("error", (err) => {
  if (err.code !== "EPIPE") throw err;
});
process.stderr?.on?.("error", (err) => {
  if (err.code !== "EPIPE") throw err;
});

// Global error handlers.
function fatalExit(label: string, err: unknown) {
  log.error(`${label}:`, err);
  try { closeDatabase(); } finally { process.exit(1); }
}

process.on("uncaughtException", (error) => {
  if (error && "code" in error && error.code === "EPIPE") return;
  fatalExit("Uncaught Exception", error);
});

process.on("unhandledRejection", (reason) => {
  fatalExit("Unhandled Rejection", reason);
});

let isShuttingDown = false;

async function gracefulShutdown(signal: string, exitCode = 0, respawn = false) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info(`Received ${signal}, shutting down gracefully...`);

  try {
    for (const runtime of getServerRuntimes()) await runtime.stop();
    panelUpdateChecker.stop();
    closeDatabase();

    // Close Engine.IO transports too, including clients not yet in a namespace.
    void io.close(() => {
      log.info("HTTP server closed");
      if (respawn) spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: "ignore", cwd: process.cwd(), env: process.env }).unref();
      process.exit(exitCode);
    });
    setTimeout(() => {
      log.error("Panel did not close cleanly; update hand-off cancelled.");
      process.exit(1);
    }, 10000).unref();
  } catch (error: any) {
    log.error("Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("message", message => {
  if (message && typeof message === "object" && "type" in message && message.type === "panel:shutdown") void gracefulShutdown("supervisor");
});

import { addLogToBuffer } from "./utils/logBuffer.ts";
import { getDiskFree } from "./utils/diskSpace.ts";
import { getSwapInfo } from "./utils/swapInfo.ts";
import { startServerRuntime } from "./services/serverRuntime.ts";
import { currentServerId, runForServer } from "./utils/serverScope.ts";
export { classifyStartupProcessState, probeRconFallbackIfConfigured } from "./services/serverDetection.ts";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const trustProxyEnv = process.env.TRUST_PROXY || "";
let trustProxySetting = parseTrustProxySetting(trustProxyEnv);
try {
  // Validate once at startup; the native host consumes the parsed value.
  if (trustProxySetting === undefined) throw new Error("invalid setting");
} catch (error: any) {
  log.warn(
    `Invalid TRUST_PROXY value (${trustProxyEnv}), proxy trust disabled: ${error.message}`,
  );
  trustProxySetting = false;
}
if (trustProxySetting) {
  const configuredProxy = Array.isArray(trustProxySetting)
    ? trustProxySetting.join(",")
    : trustProxySetting;
  log.info(
    `trust proxy enabled (${configuredProxy}) via TRUST_PROXY env var`,
  );
}
let panelRequestHandler: ReturnType<typeof createPanelRequestHandler> =
  async (_request, response) => {
    response.statusCode = 503;
    response.end("Panel is still starting");
  };
const httpServer = createServer((request, response) => {
  if (isShuttingDown) { response.statusCode = 503; response.end("Panel is restarting"); return; }
  void panelRequestHandler(request, response).catch((error: unknown) => {
    log.error("Panel request failed:", error);
    if (!response.headersSent) {
      response.statusCode = 500;
      response.end("Internal server error");
    } else {
      response.destroy();
    }
  });
});
let activePanelPort: number | null = null;

export { resolvePanelPort } from "./utils/panelInfo.ts";

const defaultAllowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3001",
];
const allowedOrigins = new Set(defaultAllowedOrigins);
const warnedCorsOrigins = new Set<string>();
const MAX_CORS_BLOCK_EVENTS = 50;
const CORS_DENY_MESSAGE =
  "Origin blocked by panel CORS policy. Open the panel from a local/LAN host, or for first-time reverse-proxy setup set CORS_ORIGINS=https://your-panel-host in the panel environment and restart it. After setup, this origin can be managed in Settings > Remote Access.";
const corsState: CorsState = {
  allowAll: false,
  allowPrivateNetworks: true,
  debug: false,
  customOrigins: new Set(),
  blocked: [],
  lastLoadedAt: null,
};

function isPrivateNetworkHost(host: unknown): boolean {
  if (typeof host !== "string" || !host) return false;
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

function isLikelyLanHostname(host: unknown): boolean {
  if (typeof host !== "string" || !host) return false;
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

function recordCorsBlock(origin: unknown, source: string): void {
  const safeOrigin = normalizeOrigin(origin) || "invalid";
  if (!warnedCorsOrigins.has(safeOrigin) && warnedCorsOrigins.size < MAX_CORS_BLOCK_EVENTS) {
    warnedCorsOrigins.add(safeOrigin);
    log.warn(`Blocked ${source} origin ${JSON.stringify(safeOrigin)}. Set CORS_ORIGINS to the exact browser origin and restart the panel.`);
  }
  if (!corsState.debug) return;
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
function addAllowedOrigin(origin: unknown): void {
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

function rebuildAllowedOriginsFromSettings(settings: AnyRecord = {}): void {
  allowedOrigins.clear();
  warnedCorsOrigins.clear();
  for (const origin of defaultAllowedOrigins) {
    addAllowedOrigin(origin);
  }

  const customOrigins = parseOriginList(settings.corsAllowedOrigins || "");
  corsState.customOrigins = new Set(customOrigins);
  for (const origin of customOrigins) {
    addAllowedOrigin(origin);
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

function isAllowedOrigin(origin: unknown): boolean {
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
  } catch (_: any) {
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
let inlineScriptCspSources = computeInlineScriptCspHashes(
  cspClientDistPath,
  log,
);
function refreshInlineScriptCspHash() {
  inlineScriptCspSources = computeInlineScriptCspHashes(cspClientDistPath, log);
  return inlineScriptCspSources.join(" ");
}
const dockerClient = new DockerClient();
setDockerClient(dockerClient);
const panelUpdateChecker = new PanelUpdateChecker(io);
setPanelRuntime({ authService, dockerClient, panelUpdateChecker, io, panelIo: io,
  refreshCorsConfig, getCorsDebugSnapshot, clearCorsBlockedOrigins,
  getListeningPort: () => activePanelPort,
  restartPanel: (exitCode: number, respawn = false) => gracefulShutdown("panel restart", exitCode, respawn),
  ensureServerRuntime: (id: string) => startServerRuntime(id, io, dockerClient) });

function resolveSourcePanelVersion(): string {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"),
  ).version;
}

let _pkgVersion: string;
let _buildSha: string;
try {
  _pkgVersion =
    typeof PANEL_VERSION !== "undefined"
      ? PANEL_VERSION
      : resolveSourcePanelVersion();
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
const isPackaged = typeof process.pkg !== "undefined";
const clientDistPath = cspClientDistPath;
const panelWebOptions = {
  isPackaged,
  clientDistPath,
  embeddedClientDistPath,
  buildMetadata: _buildMetadata,
  logger: log,
  httpsDetected,
  inlineScriptCspSources: () => inlineScriptCspSources.join(" "),
};

panelRequestHandler = createPanelRequestHandler(panelWebOptions, {
  isAllowedOrigin,
  recordCorsBlock,
  trustProxy: trustProxySetting,
});

io.use(async (socket: AuthenticatedSocket, next) => {
  try {
    const serverId = socket.handshake.auth?.serverId;
    if (serverId != null) {
      if (typeof serverId !== "string" || !/^[A-Za-z0-9_-]+$/.test(serverId) || !await getServer(serverId)) return next(new Error("Server not found"));
      socket.data.serverId = serverId;
    }
    const needsSetup = await authService.needsSetup();
    if (needsSetup) return next(new Error("First-run setup required"));

    const authEnabled = await authService.isAuthEnabled();
    if (!authEnabled) {
      socket.user = {
        userId: null,
        username: null,
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
  } catch (error: any) {
    next(new Error("Authentication error"));
  }
});

io.on("connection", (socket: AuthenticatedSocket) => {
  log.debug(
    `Client connected: ${socket.id}${socket.user ? ` (${socket.user.username})` : ""}`,
  );

  if (socket.user?.userId) {
    socket.join(`user:${socket.user.userId}`);
  }

  if (socket.data.serverId) socket.join(`server:${socket.data.serverId}`);

  socket.on("disconnect", () => {
    log.debug(`Client disconnected: ${socket.id}`);
  });

  socket.on("subscribe:status", () => {
    if (socket.user && socket.data.serverId) socket.join(`server:${socket.data.serverId}:server-status`);
  });

  socket.on("subscribe:players", async () => {
    if (!socket.user) return;
    if (socket.user && socket.data.serverId) socket.join(`server:${socket.data.serverId}:players`);
  });

  socket.on("subscribe:logs", async () => {
    if (!socket.user) return;
    if (socket.user && socket.data.serverId) socket.join(`server:${socket.data.serverId}:logs`);
  });

  socket.on("subscribe:perf", async () => {
    if (!socket.user) return;
    if (socket.user && socket.data.serverId) socket.join(`server:${socket.data.serverId}:perf`);
  });
  socket.on("unsubscribe:perf", () => {
    if (socket.data.serverId) socket.leave(`server:${socket.data.serverId}:perf`);
  });

  socket.on("subscribe:rcon", async () => {
    if (!socket.user) return;
    if (socket.user && socket.data.serverId) socket.join(`server:${socket.data.serverId}:rcon-live`);
  });
});

export function evictRevokedSockets(event: SessionRevocationEvent): void {
  if (event.scope === "all") {
    io.disconnectSockets(true);
  } else if (event.scope === "user" && event.userId) {
    io.in(`user:${event.userId}`).disconnectSockets(true);
  }
}

onSessionRevoked(evictRevokedSockets);

onLog((logEntry) => {
  addLogToBuffer(logEntry.level, logEntry.message, logEntry.source);
  const serverId = currentServerId();
  if (serverId) io.to(`server:${serverId}:logs`).emit("log:entry", logEntry);
  else io.emit("panel:log", logEntry);
});

import { getDataPaths } from "./utils/paths.ts";

export async function logExposureWarningIfNeeded({
  needsSetup,
  boundPort,
  localIp,
  authServiceInstance = authService,
  loggerInstance = log,
}: {
  needsSetup: boolean;
  boundPort: number;
  localIp: string | null;
  authServiceInstance?: { isAuthEnabled: () => Promise<boolean> };
  loggerInstance?: { warn: (...args: any[]) => void };
}): Promise<void> {
  const reachableUrl =
    localIp && localIp !== "127.0.0.1"
      ? `http://${localIp}:${boundPort}`
      : `http://<this-machine>:${boundPort}`;

  if (needsSetup) {
    loggerInstance.warn(`First-run setup: no admin account exists yet. Open ${reachableUrl} and use the setup token printed below.`);
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

async function start(): Promise<void> {
  try {
    logBanner(_buildMetadata.panelVersion);

    try {
      const { acquireLock } = await import("./utils/pidLock.ts");
      const { getDataPaths } = await import("./utils/paths.ts");
      const { dataDir } = getDataPaths();
      const lockResult = acquireLock(dataDir);
      if (!lockResult.acquired) {
        log.error(`Refusing to start: ${lockResult.reason}.`);
        log.error(
          `If you're sure no other panel is running, delete ${lockResult.lockPath} and try again.`,
        );
        process.exit(78);
      }
    } catch (err: any) {
      throw new Error(`Panel lock failed: ${err.message}`);
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
      const ask = (q: string): Promise<string> =>
        new Promise((resolve) => rl.question(q, resolve));

      let users: Awaited<ReturnType<typeof authService.getUsers>>;
      try {
        users = await authService.getUsers();
      } catch (err: any) {
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
      } catch (err: any) {
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

    for (const server of await getServers()) {
      await startServerRuntime(server.id, io, dockerClient);
    }

    panelUpdateChecker.start(_pkgVersion);


    const savedPort = await getSetting("panelPort");
    const PORT = resolvePanelPort(process.env.PORT || savedPort || 3001, {
      onInvalid: (value) =>
        log.warn(
          `Configured panel port "${value}" is not valid (must be a number 1-65535) -- using 3001 instead.`,
        ),
    });
    let listenPort = PORT;

    let listenRetries = 0;
    const maxListenRetries = 5;
    const listenWithRetry = () => {
      httpServer.listen(listenPort, async () => {
        const address = httpServer.address();
        const boundPort = address && typeof address === "object" ? address.port : listenPort;
        activePanelPort = boundPort;
        if (listenPort === 0 && !process.env.PORT && boundPort !== PORT) {
          await setSetting("panelPort", boundPort);

          log.warn(`Configured panel port ${PORT} was unavailable; switched to free port ${boundPort} and saved it.`);
        }
        logSection("Ready");
        const urls = [{ label: "Local: ", url: `http://localhost:${boundPort}` }];
        const localIp = await resolvePanelLocalIp(getSetting);
        if (localIp !== "127.0.0.1") {
          urls.push({
            label: "Network:",
            url: `http://${localIp}:${boundPort}`,
          });
        }
        logReady(urls);
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
        } catch (err: any) {
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
          } catch (e: any) {
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
          } catch (e: any) {
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
          } catch (e: any) {
            log.debug(`32-bit libs check skipped: ${e.message}`);
          }
        }

        if (typeof process.pkg !== "undefined" && shouldAutoOpenBrowser()) {
          const url = `http://localhost:${boundPort}`;

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
      if ("code" in err && err.code === "EADDRINUSE" && listenRetries < maxListenRetries) {
        listenRetries++;
        const delay = Math.min(1000 * listenRetries, 4000);
        log.warn(
          `Port ${PORT} busy, retrying in ${delay}ms (attempt ${listenRetries}/${maxListenRetries})...`,
        );
        setTimeout(listenWithRetry, delay);
      } else if ("code" in err && err.code === "EADDRINUSE") {
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
  } catch (error: any) {
    log.error("Failed to start server:", error);
    process.exit(1);
  }
}

if (!process.env.VITEST) {
  start();
}

export { io };
