import { EventEmitter } from "events";
import net from "net";
import { createLogger } from "../utils/logger.js";
const log = createLogger("RCON");
import {
  logCommand,
  getSetting,
  getActiveServer,
  getServer,
} from "../database/init.js";
import { SourceRconClient } from "../utils/sourceRcon.ts";
import { readSecret } from "../utils/secrets.ts";
import { parseBoundedInteger } from "../utils/queryNumbers.ts";
import { redactRconCommandSecrets } from "../utils/rconCommandRedaction.ts";
import { ErrorCode } from "../utils/errorCodes.ts";

const RCON_ERROR_CLASSIFICATIONS = [
  {
    test: (msg) => msg.includes("ECONNREFUSED"),
    message:
      "Cannot connect to server. Is the game server running with RCON enabled?",
    disconnect: true,
  },
  {
    test: (msg) => msg.includes("ETIMEDOUT") || msg.includes("timed out"),
    message:
      "Connection timed out. Server may be unresponsive or firewall is blocking.",
    disconnect: true,
  },
  {
    test: (msg) => msg.includes("ECONNRESET") || msg.includes("EPIPE"),
    message: "Connection was reset. Server may have restarted or crashed.",
    disconnect: true,
  },
  {
    test: (msg) => msg.includes("authentication") || msg.includes("password"),
    message: "Authentication failed. Check RCON password in server settings.",
    disconnect: false,
  },
  {
    test: (msg) => msg.includes("Max reconnection attempts"),
    message:
      "Could not reconnect after multiple attempts. Server may be offline.",
    disconnect: true,
  },
  {
    test: (msg) => msg.includes("not connected"),
    message: "Not connected to server. Please check if server is running.",
    disconnect: true,
  },
  {
    test: (msg) => msg.includes("Server is not running"),
    message: "Game server is not running.",
    disconnect: true,
  },
];

const LATIN_TRANSLITERATION_MAP = {
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a",
  À: "A", Á: "A", Â: "A", Ã: "A", Ä: "A", Å: "A",
  ç: "c", Ç: "C",
  è: "e", é: "e", ê: "e", ë: "e",
  È: "E", É: "E", Ê: "E", Ë: "E",
  ì: "i", í: "i", î: "i", ï: "i",
  Ì: "I", Í: "I", Î: "I", Ï: "I",
  ñ: "n", Ñ: "N",
  ò: "o", ó: "o", ô: "o", õ: "o", ö: "o",
  Ò: "O", Ó: "O", Ô: "O", Õ: "O", Ö: "O",
  ù: "u", ú: "u", û: "u", ü: "u",
  Ù: "U", Ú: "U", Û: "U", Ü: "U",
  ý: "y", ÿ: "y", Ý: "Y",
  œ: "oe", Œ: "OE", æ: "ae", Æ: "AE",
};

export function normalizeRconHost(host) {
  if (typeof host !== "string") return "127.0.0.1";
  return host.trim() || "127.0.0.1";
}

function parseConfiguredRconPort(value) {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return 27015;
  }
  return parseBoundedInteger(value, null, 1, 65535);
}

export function checkTcpReachable(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

export const RCON_USER_ACTION_TIMEOUT_MS = 5000;

export const RCON_UNREACHABLE_DETAIL = "Unreachable: check host and port";
export const RCON_AUTH_FAILED_DETAIL = "Authentication failed: check RCON password";

export async function testRconConnection({ host, port, password, timeoutMs = RCON_USER_ACTION_TIMEOUT_MS }) {
  const reachable = await checkTcpReachable(host, port, timeoutMs);
  if (!reachable) {
    return {
      success: false,
      error: "unreachable",
      detail: RCON_UNREACHABLE_DETAIL,
    };
  }

  const client = new SourceRconClient({ host, port, timeout: timeoutMs });
  try {
    await client.authenticate(password || "");
    return { success: true, detail: "Connected" };
  } catch {
    return {
      success: false,
      error: "auth_failed",
      detail: RCON_AUTH_FAILED_DETAIL,
    };
  } finally {
    client.disconnect();
  }
}

export const KNOWN_RCON_REJECTIONS = [
  {
    pattern: /^\s*Unknown command\b/i,
    describe: (text) => `${text}. This command is not available on this server build.`,
  },
  {
    pattern: /^\s*Wrong arguments!?\s*$/i,
    describe: () =>
      "Wrong arguments. This command's syntax may have changed on this server build.",
  },
  {
    pattern: /^\s*Not enough rights\.?\s*$/i,
    describe: () =>
      "Not enough rights. The RCON account's role does not have permission to run this command.",
  },
  {
    pattern: /can be executed only from the game\.?\s*$/i,
    describe: (text) => `${text}. This command can only be run from in-game, not over RCON.`,
  },
  {
    pattern: /^User .+ doesn't exist\.\s*$/i,
    describe: () =>
      "User doesn't exist. They may have disconnected, or the name may be misspelled.",
  },
  {
    pattern: /^\s*This user can't be kicked\.\s*$/i,
    describe: () => "This user can't be kicked (protected account).",
  },
  {
    pattern: /^\s*No such user\s*$/i,
    describe: () => "No such user. They must be currently connected for this command.",
  },
  {
    pattern: /^Invalid username ".*"\s*$/i,
    describe: (text) => `${text}. That username was not recognized.`,
  },
  {
    pattern: /^Access Level '.+' unknown, list of access level:/i,
    describe: (text) => `${text}. That access level is not recognized on this server build.`,
  },
  {
    pattern: /^You do not have sufficient rights to set this access level\.\s*$/i,
    describe: () => "You do not have sufficient rights to set this access level.",
  },
  {
    pattern: /^User ".*" is not in the whitelist nor the server, use \/adduser first\s*$/i,
    describe: (text) => `${text}.`,
  },
  {
    pattern: /^\s*This user can't be banned\.\s*$/i,
    describe: () => "This user can't be banned (protected account).",
  },
  {
    pattern: /^Cannot ban IP .+ \(Steam Relay shared address\)\. Use bansteamid or banuser instead\.\s*$/i,
    describe: (text) => `${text}`,
  },
  {
    pattern: /^Cannot ban IP for player '.+' \(Steam Relay, real IP unavailable\)\. Use bansteamid or banuser without -ip\.\s*$/i,
    describe: (text) => `${text}`,
  },
  {
    pattern: /^\s*A user with this name already exists\.?\s*$/i,
    describe: () => "A user with this name already exists.",
  },
  {
    pattern: /^User ".*" is not in the whitelist, use \/adduser first\s*$/i,
    describe: (text) => `${text}.`,
  },
  {
    pattern: /^User .+ not found\s*$/i,
    describe: () => "User not found.",
  },
  {
    pattern: /^\s*You don't have capability to ban\/unban users\.\s*$/i,
    describe: () => "You don't have capability to ban/unban users.",
  },
  // NOT added, named as the residual rather than left implicit: BanSystem.class
  // also carries "Connection not found" and "Player not found". These are
  // low-confidence candidates ("plausible RCON-reply shape but could
  // equally be internal-console-only text", not bytecode-traced to a
  // ban/unban call site at all). Two rejection shapes for
  // banuser/unbanuser/adduser/removeuserfromwhitelist remain genuinely
  // unrecognized after this fix -- inventing an attribution for either would
  // be worse than leaving them out.
];

export class RconService extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(20);

    this.client = null;
    this.connected = false;
    this.connecting = false;
    this.connectPromise = null;
    this.passwordFromSecretFile = Boolean(process.env.RCON_PASSWORD_FILE);
    this.config = {
      host: process.env.RCON_HOST || "127.0.0.1",
      port: parseInt(process.env.RCON_PORT, 10) || 27015,
      password: readSecret("RCON_PASSWORD") || "",
    };
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.baseReconnectDelay = 2000;
    this.maxReconnectDelay = 60000;

    this.lastConnectionErrorLog = 0;
    this.connectionErrorLogCooldown = 5 * 60 * 1000;
    this.configLoaded = false;
    this.serverManager = null;

    this.autoReconnectInterval = null;
    this.autoReconnectDelay = 60000;
    this.lastSuccessfulCommand = null;
    this.serverStarting = false;
    this.serverStartingTimeout = null;
    this.connectionVersion = 0;
    this.reconnecting = false;
    this.reconnectPromise = null;

    this.connectionTimeout = 10000;
    this.commandTimeout = 10000;

    this.healthCheckInterval = null;
    this.healthCheckDelay = 60000;
    this.lastHealthCheck = null;
    this.consecutiveHealthFailures = 0;
    this.maxHealthFailures = 3;

    this.pendingClients = new Set();
  }

  setServerStarting(value) {
    this.serverStarting = value;

    if (this.serverStartingTimeout) {
      clearTimeout(this.serverStartingTimeout);
      this.serverStartingTimeout = null;
    }

    if (value) {
      this.serverStartingTimeout = setTimeout(
        () => {
          if (this.serverStarting) {
            log.warn(
              "serverStarting flag was stuck for 5 minutes, clearing it",
            );
            this.serverStarting = false;
          }
        },
        5 * 60 * 1000,
      );
    }
  }

  setServerManager(serverManager) {
    this.serverManager = serverManager;
  }

  startAutoReconnect() {
    if (this.autoReconnectInterval) return;

    this.autoReconnectInterval = setInterval(async () => {
      if (this.serverStarting) {
        log.debug("Skipping - server is starting");
        return;
      }

      if (this.connected) {
        return;
      }

      if (this.connecting || this.reconnecting) {
        log.debug("Skipping - connection already in progress");
        return;
      }

      try {
        if (this.serverManager) {
          try {
            const isRunning = await this.serverManager.checkServerRunning();
            if (isRunning) {
              log.info("Server is running, attempting connection...");
            } else {
              log.debug(
                "Process check did not confirm server; probing RCON port anyway",
              );
            }
          } catch (e) {
            log.debug(`Server check error: ${e.message}`);
          }
        }

        const result = await this.connect();
        if (result) {
          log.info("Successfully connected!");
        }
      } catch (e) {
        if (this.serverStarting) {
          log.debug(`Connection failed during startup, retrying: ${e.message}`);
        } else {
          log.warn(
            `Connection failed, retrying in ${this.autoReconnectDelay}ms: ${e.message}`,
          );
        }
        // This loop intentionally uses a fixed interval (autoReconnectDelay),
        // not exponential backoff — the separate reconnect() method below
        // implements real backoff (baseReconnectDelay * attempt, capped) for
        // its own bounded retry sequence. A previous `currentReconnectDelay`
        // field here was computed on every failure but never actually fed
        // into this setInterval's delay, so it was pure dead weight that
        // made the log message above lie about the real retry timing.
      }
    }, this.autoReconnectDelay);
    if (this.autoReconnectInterval.unref) this.autoReconnectInterval.unref();

    this.startHealthCheck();

    log.debug("auto-reconnect enabled (60s interval)");
  }

  startHealthCheck() {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(async () => {
      if (!this.connected || !this.client) {
        this.consecutiveHealthFailures = 0;
        return;
      }

      if (this.serverStarting) {
        return;
      }

      try {
        const result = await this.healthCheck();
        this.lastHealthCheck = Date.now();

        if (result.healthy) {
          this.consecutiveHealthFailures = 0;
          log.debug("health check: OK");
        } else {
          this.consecutiveHealthFailures++;
          log.warn(
            `health check failed (${this.consecutiveHealthFailures}/${this.maxHealthFailures}): ${result.reason}`,
          );

          if (this.consecutiveHealthFailures >= this.maxHealthFailures) {
            log.error("health check: Too many failures, forcing disconnect");
            this.forceResetConnectionState();
          }
        }
      } catch (e) {
        this.consecutiveHealthFailures++;
        log.warn(
          `health check error (${this.consecutiveHealthFailures}/${this.maxHealthFailures}): ${e.message}`,
        );

        if (this.consecutiveHealthFailures >= this.maxHealthFailures) {
          log.error("health check: Too many errors, forcing disconnect");
          this.forceResetConnectionState();
        }
      }
    }, this.healthCheckDelay);
    if (this.healthCheckInterval.unref) this.healthCheckInterval.unref();

    log.debug("health check enabled (60s interval)");
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      this.consecutiveHealthFailures = 0;
    }
  }

  stopAutoReconnect() {
    if (this.autoReconnectInterval) {
      clearInterval(this.autoReconnectInterval);
      this.autoReconnectInterval = null;
      log.info("auto-reconnect disabled");
    }
    this.stopHealthCheck();
  }

  async loadConfig(serverId = null) {
    if (this.configLoaded) return;
    try {
      const targetServer = serverId
        ? await getServer(serverId)
        : await getActiveServer();
      if (targetServer) {
        this.config.host = normalizeRconHost(targetServer.rconHost);
        this.config.port = parseConfiguredRconPort(targetServer.rconPort);

        if (targetServer.rconPassword) {
          if (!this.passwordFromSecretFile) {
            this.config.password = targetServer.rconPassword;
          }
        } else if (!this.passwordFromSecretFile) {
          this.config.password = "";
          log.warn(
            serverId
              ? `Server ${serverId} has no RCON password set — connection attempts will fail authentication until one is configured`
              : "Active server has no RCON password set — connection attempts will fail authentication until one is configured",
          );
        }

        log.info(
          serverId
            ? `config loaded for server ${serverId}`
            : "config loaded from active server",
        );
        this.configLoaded = true;
        return;
      }

      if (!serverId) {
        const dbHost = await getSetting("rconHost");
        const dbPort = await getSetting("rconPort");
        const dbPassword = await getSetting("rconPassword");

        if (dbPassword && !this.passwordFromSecretFile) {
          this.config.password = dbPassword;
          log.info("password loaded from legacy settings");
        }
        if (dbPort !== undefined && dbPort !== null && dbPort !== "") {
          this.config.port = parseConfiguredRconPort(dbPort);
        }
        if (dbHost) {
          this.config.host = normalizeRconHost(dbHost);
        }
      } else {
        log.warn(`No RCON config found for server ${serverId}`);
      }
      this.configLoaded = true;
    } catch (error) {
      log.debug(`Could not load RCON config from database: ${error.message}`);
    }
  }

  async hasConfiguredTarget() {
    try {
      if (await getActiveServer()) return true;
    } catch (e) {
      log.debug(`hasConfiguredTarget: active server lookup failed: ${e.message}`);
    }
    try {
      const [dbHost, dbPort, dbPassword] = await Promise.all([
        getSetting("rconHost"),
        getSetting("rconPort"),
        getSetting("rconPassword"),
      ]);
      return Boolean(dbHost || dbPort || dbPassword);
    } catch (e) {
      log.debug(`hasConfiguredTarget: legacy settings lookup failed: ${e.message}`);
      return false;
    }
  }

  async reloadConfig(serverId = null) {
    this.configLoaded = false;
    if (this.connected) {
      await this.disconnect();
    }
    await this.loadConfig(serverId);
  }

  forceResetConnectionState() {
    this.connectionVersion++;
    const version = this.connectionVersion;
    log.info(`Force resetting connection state (version ${version})`);

    this.connecting = false;
    this.connectPromise = null;
    this.reconnecting = false;
    this.reconnectPromise = null;
    this.reconnectAttempts = 0;
    this.connected = false;
    this.consecutiveHealthFailures = 0;

    if (this.serverStartingTimeout) {
      clearTimeout(this.serverStartingTimeout);
      this.serverStartingTimeout = null;
    }
    this.serverStarting = false;

    this._cleanupAllPendingClients();

    this._cleanupClient();

    log.info(`Connection state forcibly reset (ready for new attempt)`);
    this.emit("disconnected");
  }

  _cleanupClient(clientToClean = null) {
    const client = clientToClean || this.client;
    if (!client) return;

    this.pendingClients.delete(client);

    try {
      client.disconnect();
    } catch (e) {
      // Ignore cleanup errors
    }

    if (client === this.client) {
      this.client = null;
    }
  }

  _cleanupAllPendingClients() {
    for (const client of this.pendingClients) {
      this._cleanupClient(client);
    }
    this.pendingClients.clear();
  }

  async connect() {
    if (this.connected && this.client) {
      return true;
    }

    if (this.connecting && this.connectPromise) {
      return this.connectPromise;
    }

    this.connecting = true;
    const connectPromise = this._doConnect();
    this.connectPromise = connectPromise;

    try {
      const result = await connectPromise;
      return result;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connecting = false;
        this.connectPromise = null;
      }
    }
  }

  async checkPortOpen(host, port) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(2000);

      const onConnect = () => {
        socket.destroy();
        resolve(true);
      };

      const onError = () => {
        socket.destroy();
        resolve(false);
      };

      socket.once("connect", onConnect);
      socket.once("timeout", onError);
      socket.once("error", onError);

      try {
        socket.connect(port, host);
      } catch (e) {
        onError();
      }
    });
  }

  async _doConnect() {
    const startVersion = this.connectionVersion;

    if (!(await this.hasConfiguredTarget())) {
      log.debug(
        "No RCON server configured yet — skipping connection attempt",
      );
      return false;
    }

    await this.loadConfig();

    if (!Number.isInteger(this.config.port) || this.config.port < 1 || this.config.port > 65535) {
      log.warn("RCON port configuration is invalid; skipping connection attempt");
      return false;
    }

    if (this.connectionVersion !== startVersion) {
      log.info("Connection attempt cancelled (force reset occurred)");
      return false;
    }

    const skipServerCheck = process.env.RCON_SKIP_SERVER_CHECK === "true";

    if (!skipServerCheck && this.serverManager) {
      let timeoutId;
      try {
        const checkPromise = this.serverManager.checkServerRunning();
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("Server check timeout")),
            5000,
          );
        });

        const isServerRunning = await Promise.race([
          checkPromise,
          timeoutPromise,
        ]);
        clearTimeout(timeoutId);
        if (!isServerRunning) {
          log.debug(
            "Process check did not detect the server; continuing with RCON port probe",
          );
          this.connected = false;
        }
      } catch (error) {
        clearTimeout(timeoutId);
        log.debug(
          `Server check failed (${error.message}), attempting connection anyway...`,
        );
      }
    }

    try {
      const isOpen = await this.checkPortOpen(
        this.config.host,
        this.config.port,
      );
      if (!isOpen) {
        const now = Date.now();
        if (now - this.lastConnectionErrorLog > this.connectionErrorLogCooldown) {
          this.lastConnectionErrorLog = now;
          log.warn(
            `RCON ${this.config.host}:${this.config.port} is not reachable - check the host, port, and that RCON is enabled on the server`,
          );
        }
        return false;
      }
    } catch (e) {
      log.debug(`Port check error: ${e.message}`);
      return false;
    }

    if (this.connectionVersion !== startVersion) {
      log.info("Connection attempt cancelled (force reset occurred)");
      return false;
    }

    if (this.connected && this.client) {
      return true;
    }

    let newClient = null;
    try {
      if (this.client) {
        try {
          this.client.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
        this.client = null;
      }

      log.info(
        `Creating new client for ${this.config.host}:${this.config.port} (version ${startVersion})`,
      );

      newClient = new SourceRconClient({
        host: this.config.host,
        port: this.config.port,
        timeout: 5000,
      });

      this.pendingClients.add(newClient);
      this.client = newClient;

      log.info("Calling authenticate()...");

      let authTimeoutId;
      const authPromise = this.client.authenticate(this.config.password);
      const timeoutPromise = new Promise((_, reject) => {
        authTimeoutId = setTimeout(() => {
          reject(
            new Error(
              `Authentication timed out after ${this.connectionTimeout}ms`,
            ),
          );
        }, this.connectionTimeout);
      });

      try {
        await Promise.race([authPromise, timeoutPromise]);
      } finally {
        clearTimeout(authTimeoutId);
      }

      if (this.connectionVersion !== startVersion) {
        log.info(
          "Connection succeeded but version changed - discarding stale connection",
        );
        this._cleanupClient(newClient);
        return false;
      }

      this.pendingClients.delete(newClient);
      this.connected = true;
      this.reconnectAttempts = 0;
      this.consecutiveHealthFailures = 0;

      log.info(`connected to ${this.config.host}:${this.config.port}`);
      this.emit("connected");
      return true;
    } catch (error) {
      const ownsCurrentClient = newClient && this.client === newClient;
      if (newClient) {
        this._cleanupClient(newClient);
      } else if (this.connectionVersion === startVersion && !this.connecting) {
        this._cleanupClient();
      }
      if (
        ownsCurrentClient ||
        (!newClient && this.connectionVersion === startVersion)
      ) {
        this.connected = false;
      }

      const now = Date.now();
      if (now - this.lastConnectionErrorLog > this.connectionErrorLogCooldown) {
        this.lastConnectionErrorLog = now;
        if (this.serverStarting) {
          log.debug(`connection failed during startup: ${error.message}`);
        } else if (
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("ETIMEDOUT") ||
          error.message.includes("timed out")
        ) {
          log.warn(
            `connection failed (server may be offline): ${error.message}`,
          );
        } else {
          log.error(`connection failed: ${error.message}`);
        }
      }
      throw error;
    }
  }

  async disconnect() {
    const wasConnected = this.connected;

    if (this.client) {
      this._cleanupClient();
    }

    this.connected = false;
    this.lastSuccessfulCommand = null;

    if (wasConnected) {
      log.info("disconnected");
      this.emit("disconnected");
    }
  }

  async reconnect() {
    if (this.serverStarting) {
      log.debug("reconnect: Skipping - server is starting");
      return false;
    }

    const reconnectStartVersion = this.connectionVersion;

    if (this.connected) {
      log.debug("reconnect: Already connected");
      return true;
    }

    if (this.reconnecting && this.reconnectPromise) {
      log.debug(
        "reconnect: Already in progress, waiting for existing attempt...",
      );
      return this.reconnectPromise;
    }

    if (this.connecting && this.connectPromise) {
      log.debug("reconnect: Connection in progress, waiting...");
      try {
        const result = await this.connectPromise;
        return this.connectionVersion === reconnectStartVersion ? result : false;
      } catch (e) {
        // Connection failed, continue to reconnect
      }
    }

    this.reconnecting = true;
    const reconnectPromise = this._doReconnect();
    this.reconnectPromise = reconnectPromise;

    try {
      const result = await reconnectPromise;
      return result;
    } finally {
      if (this.reconnectPromise === reconnectPromise) {
        this.reconnecting = false;
        this.reconnectPromise = null;
      }
    }
  }

  async _doReconnect() {
    const startVersion = this.connectionVersion;

    await this.disconnect();

    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      if (this.connectionVersion !== startVersion) {
        log.debug("reconnect: Version changed (force reset), aborting");
        this.reconnectAttempts = 0;
        return false;
      }

      this.reconnectAttempts++;
      log.info(`reconnecting... Attempt ${this.reconnectAttempts}`);

      const delay = Math.min(
        this.baseReconnectDelay * this.reconnectAttempts,
        30000,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));

      if (this.connectionVersion !== startVersion) {
        log.debug("reconnect: Version changed (force reset), aborting");
        this.reconnectAttempts = 0;
        return false;
      }

      if (this.serverStarting) {
        log.debug("reconnect: Server starting, aborting reconnect loop");
        this.reconnectAttempts = 0;
        return false;
      }

      if (this.connected) {
        log.debug("reconnect: Already connected, stopping");
        this.reconnectAttempts = 0;
        return true;
      }

      try {
        const result = await this.connect();
        if (this.connectionVersion !== startVersion) {
          this.reconnectAttempts = 0;
          return false;
        }
        if (result) {
          this.reconnectAttempts = 0;
          log.info("reconnected successfully");
          return true;
        }
        log.debug("reconnect: Server not running, stopping attempts");
        this.reconnectAttempts = 0;
        return false;
      } catch (error) {
        log.debug(
          `reconnect attempt ${this.reconnectAttempts} failed: ${error.message}`,
        );
      }
    }

    log.warn(
      `reconnect: Max attempts (${this.maxReconnectAttempts}) reached, giving up. Auto-reconnect will retry later.`,
    );
    this.reconnectAttempts = 0;
    return false;
  }

  classifyRconResponse(response) {
    if (typeof response !== "string" || !response) return null;
    const trimmed = response.trim();
    for (const { pattern, describe } of KNOWN_RCON_REJECTIONS) {
      if (pattern.test(trimmed)) {
        return { error: describe(trimmed), response: trimmed };
      }
    }
    return null;
  }

  async execute(
    command,
    { skipLog = false, retryOnConnectionError = false } = {},
  ) {
    let commandClient = null;
    let commandSent = false;
    try {
      if (this.serverStarting) {
        return { success: false, error: "Server is starting, please wait..." };
      }

      if (!this.connected) {
        const connectResult = await this.connect();
        if (connectResult === false) {
          return {
            success: false,
            error: "Server is not running",
            code: ErrorCode.RCON_EXECUTE_DISCONNECTED,
          };
        }
      }

      log.debug(`executing: ${redactRconCommandSecrets(command)}`);

      commandClient = this.client;
      if (!commandClient || typeof commandClient.execute !== "function") {
        throw new Error("RCON not connected");
      }
      commandSent = true;
      let timeoutId;
      const executePromise = commandClient.execute(command);
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Command execution timed out")),
          this.commandTimeout,
        );
      });

      let response;
      try {
        response = await Promise.race([executePromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutId);
      }

      if (this.client === commandClient && this.connected) {
        this.lastSuccessfulCommand = Date.now();
        this.consecutiveHealthFailures = 0;
      }

      log.debug(`response: ${response}`);

      const rejection = this.classifyRconResponse(response);

      if (!skipLog) {
        logCommand(command, rejection ? rejection.error : response, !rejection);
      }

      if (rejection) {
        log.warn(`Server rejected command: ${redactRconCommandSecrets(command)} (${rejection.response})`);
        return { success: false, error: rejection.error, response: rejection.response };
      }

      return {
        success: true,
        response: response || "Command executed successfully",
      };
    } catch (error) {
      const errorMsg = error.message || "Unknown error";

      const isConnectionError =
        errorMsg.includes("ECONNREFUSED") ||
        errorMsg.includes("ETIMEDOUT") ||
        errorMsg.includes("ECONNRESET") ||
        errorMsg.includes("EPIPE") ||
        errorMsg.includes("not connected") ||
        errorMsg.includes("timeout") ||
        errorMsg.includes("timed out") ||
        errorMsg.includes("socket");

      const isServerOffline = errorMsg.includes("Server is not running");

      if (isConnectionError || isServerOffline) {
        log.debug(
          `command skipped (${isServerOffline ? "server offline" : "connection error"}): ${command}`,
        );
      } else {
        log.warn(`command failed: ${errorMsg}`);
      }

      if (isConnectionError) {
        const wasCurrentClient = commandClient && this.client === commandClient;
        if (commandClient) {
          this._cleanupClient(commandClient);
        } else {
          this._cleanupClient();
        }
        if (wasCurrentClient || !commandClient) {
          this.connected = false;
        }

        if (this.serverStarting) {
          if (!skipLog) {
            logCommand(command, "Server is starting...", false);
          }
          return {
            success: false,
            error: "Server is starting, please wait...",
          };
        }

        if (!retryOnConnectionError) {
          const friendlyError = this.getUserFriendlyError(errorMsg);
          if (!skipLog) {
            logCommand(command, friendlyError, false);
          }
          return {
            success: false,
            error: friendlyError,
            commandSent:
              commandSent && !/^RCON not connected$/i.test(errorMsg.trim()),
            transportError: true,
          };
        }

        try {
          await this.reconnect();
          const retryClient = this.client;
          if (this.connected && retryClient) {
            let retryTimeoutId;
            const retryExecutePromise = retryClient.execute(command);
            const retryTimeoutPromise = new Promise((_, reject) => {
              retryTimeoutId = setTimeout(
                () => reject(new Error("Command execution timed out")),
                this.commandTimeout,
              );
            });

            let response;
            try {
              response = await Promise.race([
                retryExecutePromise,
                retryTimeoutPromise,
              ]);
            } catch (retryError) {
              const retryWasCurrentClient = this.client === retryClient;
              this._cleanupClient(retryClient);
              if (retryWasCurrentClient) this.connected = false;
              const retryMsg = this.getUserFriendlyError(retryError.message);
              if (!skipLog) {
                logCommand(command, retryMsg, false);
              }
              return {
                success: false,
                error: retryMsg,
                commandSent:
                  !/^RCON not connected$/i.test(retryError.message.trim()),
                transportError: true,
              };
            } finally {
              clearTimeout(retryTimeoutId);
            }

            if (this.client === retryClient && this.connected) {
              this.lastSuccessfulCommand = Date.now();
            }

            const rejection = this.classifyRconResponse(response);
            if (!skipLog) {
              logCommand(command, rejection ? rejection.error : response, !rejection);
            }
            if (rejection) {
              log.warn(`Server rejected command on retry: ${redactRconCommandSecrets(command)} (${rejection.response})`);
              return { success: false, error: rejection.error, response: rejection.response };
            }
            return {
              success: true,
              response: response || "Command executed successfully",
            };
          } else {
            if (!skipLog) {
              logCommand(command, "Connection failed", false);
            }
            return {
              success: false,
              error: "RCON reconnection failed",
              code: ErrorCode.RCON_EXECUTE_DISCONNECTED,
              commandSent,
              transportError: true,
            };
          }
        } catch (reconnectError) {
          const reconnectMsg = this.getUserFriendlyError(
            reconnectError.message,
          );
          if (!skipLog) {
            logCommand(command, reconnectMsg, false);
          }
          return {
            success: false,
            error: reconnectMsg,
            code: this.getRconDisconnectCode(reconnectError.message),
            commandSent,
            transportError: true,
          };
        }
      }

      const friendlyError = this.getUserFriendlyError(errorMsg);
      if (!skipLog) {
        logCommand(command, friendlyError, false);
      }
      return {
        success: false,
        error: friendlyError,
        code: this.getRconDisconnectCode(errorMsg),
      };
    }
  }

  getUserFriendlyError(errorMsg) {
    if (!errorMsg) return "Unknown error occurred";
    const match = RCON_ERROR_CLASSIFICATIONS.find((c) => c.test(errorMsg));
    return match ? match.message : errorMsg;
  }

  getRconDisconnectCode(errorMsg) {
    if (!errorMsg) return null;
    const match = RCON_ERROR_CLASSIFICATIONS.find((c) => c.test(errorMsg));
    return match?.disconnect ? ErrorCode.RCON_EXECUTE_DISCONNECTED : null;
  }

  sanitize(input) {
    if (input === null || input === undefined) return "";
    return String(input).replace(/["\\]|[\x00-\x1F\x7F]/g, "");
  }

  sanitizeQuotedArg(input, label = "RCON argument", maxLength = 128) {
    if (input === null || input === undefined) {
      throw new Error(`${label} is required`);
    }
    const value = String(input).trim();
    if (!value) {
      throw new Error(`${label} is required`);
    }
    if (value.length > maxLength) {
      throw new Error(`${label} is too long`);
    }
    if (/["\\]|[\x00-\x1F\x7F]/.test(value)) {
      throw new Error(`${label} contains unsupported characters`);
    }
    return value;
  }

  foldToRconAscii(input) {
    return String(input ?? "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/[\u2026]/g, "...")
      .replace(/[\u00C0-\u024F]/g, (ch) => LATIN_TRANSLITERATION_MAP[ch] ?? "")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  sanitizeServerMessage(input) {
    return this.sanitize(String(input ?? "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\u2026/g, "..."))
      .replace(/\p{So}|\p{Sk}|\p{Sm}|\p{Sc}|\u200D|\uFE0E|\uFE0F/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  async save({ skipLog = false, retryOnConnectionError = false } = {}) {
    return this.execute("save", { skipLog, retryOnConnectionError });
  }

  async quit({ skipLog = false, retryOnConnectionError = false } = {}) {
    const quitClient = this.client;
    const result = await this.execute("quit", {
      skipLog,
      retryOnConnectionError,
    });
    if (this.client === quitClient) {
      this.connected = false;
      this._cleanupClient(quitClient);
    }
    if (
      !result.success &&
      result.commandSent === true &&
      result.transportError === true
    ) {
      return { success: true, response: "Server shutting down" };
    }
    return result;
  }

  async serverMessage(message, { skipLog = false } = {}) {
    const safeMessage = this.sanitizeServerMessage(message);
    if (!safeMessage) {
      log.warn(
        "serverMessage: message reduced to empty after sanitization, skipping",
      );
      return { success: false, response: "Empty message after sanitization" };
    }
    const result = await this.execute(`servermsg "${safeMessage}"`, {
      skipLog,
    });
    if (
      result?.success &&
      typeof result.response === "string" &&
      /Use:\s*\/servermsg/i.test(result.response)
    ) {
      log.warn(
        `servermsg appears to have been rejected by PZ (help text returned). Message was: ${safeMessage.substring(0, 80)}`,
      );
      return { success: false, response: result.response, rejected: true };
    }
    return result;
  }

  async getPlayers() {
    const result = await this.execute("players", {
      skipLog: true,
      retryOnConnectionError: true,
    });
    if (result.success) {
      return {
        success: true,
        players: this.parsePlayers(result.response),
      };
    }
    return result;
  }

  parsePlayers(response) {
    const players = [];
    if (!response) return players;

    const lines = response.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("-")) {
        players.push({
          name: trimmed.substring(1).trim(),
          online: true,
        });
      }
    }
    return players;
  }

  async kickPlayer(username, reason = "") {
    const safeUser = this.sanitizeQuotedArg(username, "Username", 64);
    const safeReason = this.sanitizeForBanReason(reason);
    let cmd = `kickuser "${safeUser}"`;
    if (safeReason) cmd += ` -r "${safeReason}"`;
    return this.execute(cmd);
  }

  sanitizeForBanReason(input) {
    if (!input) return "";
    return this.foldToRconAscii(input)
      .replace(/[^a-zA-Z0-9\s.,!?'-]/g, "")
      .substring(0, 100);
  }

  async banPlayer(username, banIp = false, reason = "") {
    const safeUser = this.sanitizeQuotedArg(username, "Username", 64);
    const safeReason = this.sanitizeForBanReason(reason);
    let cmd = `banuser "${safeUser}"`;
    if (banIp) cmd += " -ip";
    if (safeReason) cmd += ` -r "${safeReason}"`;
    const result = await this.execute(cmd);
    return { ...result, sentReason: safeReason };
  }

  async unbanPlayer(username) {
    return this.execute(
      `unbanuser "${this.sanitizeQuotedArg(username, "Username", 64)}"`,
    );
  }

  async setAccessLevel(username, level) {
    return this.execute(
      `setaccesslevel "${this.sanitizeQuotedArg(username, "Username", 64)}" "${this.sanitizeQuotedArg(level, "Access level", 32)}"`,
    );
  }

  async addToWhitelist(username, password) {
    const safeUser = this.sanitizeQuotedArg(username, "Username", 64);
    if (password === undefined || password === null || password === "") {
      return this.execute(`adduser "${safeUser}"`);
    }
    const safePassword = this.sanitizeQuotedArg(password, "Password", 128);
    return this.execute(`adduser "${safeUser}" "${safePassword}"`);
  }

  async removeFromWhitelist(username) {
    return this.execute(
      `removeuserfromwhitelist "${this.sanitizeQuotedArg(username, "Username", 64)}"`,
    );
  }

  async teleportPlayer(player1, player2 = null) {
    const safeP1 = this.sanitizeQuotedArg(player1, "Username", 64);
    if (player2) {
      return this.execute(
        `teleport "${safeP1}" "${this.sanitizeQuotedArg(player2, "Target username", 64)}"`,
      );
    }
    return this.execute(`teleport "${safeP1}"`);
  }

  async teleportTo(x, y, z) {
    const nx = Number(x),
      ny = Number(y),
      nz = Number(z);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
      throw new Error("Coordinates must be valid numbers");
    }
    return this.execute(`teleportto ${nx},${ny},${nz}`);
  }

  async addItem(username, item, count = 1) {
    const safeItem = this.sanitizeQuotedArg(item, "Item ID", 128);
    const n = Math.min(Math.max(Math.floor(Number(count)) || 1, 1), 100);
    if (username) {
      return this.execute(
        `additem "${this.sanitizeQuotedArg(username, "Username", 64)}" "${safeItem}" ${n}`,
      );
    }
    return this.execute(`additem "${safeItem}" ${n}`);
  }

  async addXp(username, perk, amount) {
    const n = Number(amount);
    if (!Number.isFinite(n)) throw new Error("amount must be a number");
    if (!/^[A-Za-z]+$/.test(String(perk))) {
      throw new Error("Perk must be alphabetic");
    }
    return this.execute(
      `addxp "${this.sanitizeQuotedArg(username, "Username", 64)}" ${perk}=${n}`,
    );
  }

  async addVehicle(vehicle, username = null) {
    const safeVehicle = this.sanitizeQuotedArg(vehicle, "Vehicle ID", 128);
    if (username) {
      return this.execute(
        `addvehicle "${safeVehicle}" "${this.sanitizeQuotedArg(username, "Username", 64)}"`,
      );
    }
    return this.execute(`addvehicle "${safeVehicle}"`);
  }

  async addVehicleAt(vehicle, x, y, z = 0) {
    const safeVehicle = this.sanitizeQuotedArg(vehicle, "Vehicle ID", 128);
    const coordinates = [x, y, z].map(Number);
    if (!coordinates.every(Number.isFinite)) {
      throw new Error("Coordinates must be valid numbers");
    }
    return this.execute(
      `addvehicle "${safeVehicle}" "${coordinates.map(Math.floor).join(",")}"`,
    );
  }

  async startRain(intensity = null) {
    if (intensity !== null && intensity !== undefined) {
      const n = Number(intensity);
      if (!Number.isFinite(n) || n < 0 || n > 1)
        throw new Error("intensity must be 0-1");
      return this.execute(`startrain ${n}`);
    }
    return this.execute("startrain");
  }

  async stopRain() {
    return this.execute("stoprain");
  }

  async startStorm(duration = null) {
    const n = duration === null || duration === undefined ? 2.0 : Number(duration);
    if (!Number.isFinite(n) || n < 0 || n > 168)
      throw new Error("duration must be 0-168");
    return this.execute(`startstorm ${n}`);
  }

  async stopWeather() {
    return this.execute("stopweather");
  }

  async triggerChopper() {
    return this.execute("chopper");
  }

  async triggerGunshot() {
    return this.execute("gunshot");
  }

  async triggerLightning(username = null) {
    if (username) {
      return this.execute(
        `lightning "${this.sanitizeQuotedArg(username, "Username", 64)}"`,
      );
    }
    return this.execute("lightning");
  }

  async triggerThunder(username = null) {
    if (username) {
      return this.execute(
        `thunder "${this.sanitizeQuotedArg(username, "Username", 64)}"`,
      );
    }
    return this.execute("thunder");
  }

  async createHorde(count, username = null) {
    const n = Math.min(Math.max(Math.floor(Number(count)) || 50, 1), 500);
    if (username) {
      return this.execute(
        `createhorde ${n} "${this.sanitizeQuotedArg(username, "Username", 64)}"`,
      );
    }
    return this.execute(`createhorde ${n}`);
  }

  async setGodMode(username, enabled) {
    const value = enabled ? "-true" : "-false";
    if (username) {
      return this.execute(
        `godmodplayer "${this.sanitizeQuotedArg(username, "Username", 64)}" ${value}`,
      );
    }
    return this.execute(`godmod ${value}`);
  }

  async setInvisible(username, enabled) {
    const value = enabled ? "-true" : "-false";
    if (username) {
      return this.execute(
        `invisibleplayer "${this.sanitizeQuotedArg(username, "Username", 64)}" ${value}`,
      );
    }
    return this.execute(`invisible ${value}`);
  }

  async setNoclip(username, enabled) {
    const value = enabled ? "-true" : "-false";
    if (username) {
      return this.execute(
        `noclip "${this.sanitizeQuotedArg(username, "Username", 64)}" ${value}`,
      );
    }
    return this.execute(`noclip ${value}`);
  }

  async checkModsNeedUpdate() {
    return this.execute("checkModsNeedUpdate", { retryOnConnectionError: true });
  }

  async showOptions() {
    return this.execute("showoptions", { retryOnConnectionError: true });
  }

  async reloadOptions() {
    return this.execute("reloadoptions");
  }

  async changeOption(optionName, newValue) {
    const safeName = this.sanitizeQuotedArg(optionName, "Option name", 64);
    return this.execute(
      `changeoption "${safeName}" "${this.sanitize(newValue)}"`,
    );
  }

  async banSteamId(steamId) {
    const safeId = String(steamId ?? "").trim();
    if (!/^\d{17}$/.test(safeId)) {
      throw new Error("Steam ID must be a 17-digit number");
    }
    return this.execute(`banid ${safeId}`);
  }

  async unbanSteamId(steamId) {
    const safeId = String(steamId ?? "").trim();
    if (!/^\d{17}$/.test(safeId)) {
      throw new Error("Steam ID must be a 17-digit number");
    }
    return this.execute(`unbanid ${safeId}`);
  }

  async addAllowedSteamId(steamId) {
    return this.execute(`addSteamID ${this.sanitizeQuotedArg(steamId, "SteamID", 17)}`);
  }

  async removeAllowedSteamId(steamId) {
    return this.execute(`removeSteamID ${this.sanitizeQuotedArg(steamId, "SteamID", 17)}`);
  }

  async voiceBan(username, enabled) {
    const value = enabled ? "-true" : "-false";
    return this.execute(
      `voiceban "${this.sanitizeQuotedArg(username, "Username", 64)}" ${value}`,
    );
  }

  async addUser(username, password) {
    const safeUser = this.sanitizeQuotedArg(username, "Username", 64);
    if (password === undefined || password === null || password === "") {
      return this.execute(`adduser "${safeUser}"`);
    }
    return this.execute(
      `adduser "${safeUser}" "${this.sanitizeQuotedArg(password, "Password", 128)}"`,
    );
  }

  async addAllToWhitelist() {
    throw new Error(
      "Build 42 removed the bulk whitelist command. Add players individually with a username and password.",
    );
  }

  async alarm() {
    return this.execute("alarm");
  }

  async reloadLua(filename) {
    return this.execute(`reloadlua "${this.sanitize(filename)}"`);
  }

  async setLogLevel(type, level) {
    const safeType = this.sanitizeQuotedArg(type, "Log type", 32);
    const safeLevel = this.sanitizeQuotedArg(String(level), "Log level", 32);
    return this.execute(`log "${safeType}" "${safeLevel}"`);
  }

  async setStats(mode, period = null) {
    const safeMode = this.sanitizeQuotedArg(mode, "Stats mode", 32);
    if (period !== null && period !== undefined && period !== "") {
      const n = Number(period);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error("period must be a non-negative number");
      }
      return this.execute(`stats "${safeMode}" ${n}`, {
        retryOnConnectionError: true,
      });
    }
    return this.execute(`stats "${safeMode}"`, {
      retryOnConnectionError: true,
    });
  }

  async removeZombies() {
    return this.execute("removezombies");
  }

  async releaseSafehouse() {
    throw new Error(
      "Releasing a safehouse can only be done from in-game -- Project Zomboid's server refuses this over RCON, even from an admin console.",
    );
  }

  async healthCheck() {
    if (!this.connected || !this.client) {
      return { healthy: false, reason: "Not connected" };
    }

    const healthClient = this.client;
    let timeoutId;
    try {
      await Promise.race([
        healthClient.execute("players"),
        new Promise((_, reject) =>
          (timeoutId = setTimeout(
            () => reject(new Error("Health check timed out")),
            10000,
          )),
        ),
      ]);
      if (this.client !== healthClient || !this.connected) {
        return { healthy: false, reason: "Connection changed" };
      }
      this.lastSuccessfulCommand = Date.now();
      return { healthy: true, lastCommand: this.lastSuccessfulCommand };
    } catch (error) {
      if (this.client !== healthClient) {
        return { healthy: false, reason: "Connection changed" };
      }
      this.connected = false;
      this._cleanupClient(healthClient);
      log.warn(`health check failed: ${error.message}`);
      this.emit("disconnected");
      return { healthy: false, reason: error.message };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  isConnected() {
    return this.connected;
  }

  getConfig() {
    return {
      host: this.config.host,
      port: this.config.port,
      connected: this.connected,
      lastSuccessfulCommand: this.lastSuccessfulCommand,
      reconnectAttempts: this.reconnectAttempts,
      autoReconnectEnabled: !!this.autoReconnectInterval,
    };
  }

  async updateConfig(host, port, password) {
    this.config.host = host !== undefined ? host : this.config.host;
    this.config.port = port !== undefined ? port : this.config.port;
    this.config.password =
      password !== undefined ? password : this.config.password;

    if (this.connected) {
      await this.disconnect();
    }
  }
}
