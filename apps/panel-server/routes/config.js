import express from "express";
import fs from "fs";
import { createLogger } from "../utils/logger.ts";
const log = createLogger("API:Config");
import { getAllSettings, getSetting, setSetting } from "../database/init.js";
import {
  sanitizeError,
  sanitizeErrorParams,
  SENSITIVE_FIELD_RE,
  isMaskedSecret,
  maskSensitiveObject,
} from "../utils/sanitize.ts";
import net from "net";
import { requirePermission, getRoleByName } from "../services/permissions.ts";
import {
  MOD_CHECK_INTERVAL_MINUTES_MAX,
  MOD_CHECK_INTERVAL_MINUTES_MIN,
  minutesToCheckIntervalMs,
} from "../services/modChecker.js";
import {
  checkTcpReachable,
  RCON_UNREACHABLE_DETAIL,
  RCON_AUTH_FAILED_DETAIL,
  RCON_USER_ACTION_TIMEOUT_MS,
} from "../services/rcon.js";
import { ErrorCode } from "../utils/errorCodes.ts";
import {
  requireIntInRange,
  BIND_PORT_MIN,
  BIND_PORT_MAX,
  GAME_PORT_MAX,
  DESTINATION_PORT_MIN,
  DESTINATION_PORT_MAX,
  MEMORY_GB_MIN,
  MIN_MEMORY_GB_MAX,
  MAX_MEMORY_GB_MAX,
} from "./server.js";
import { parseBoundedInteger } from "../utils/queryNumbers.ts";
import { setSteamSessionCredentials } from "../services/steamSessionCredentials.ts";

const AUTO_EXPORT_MAX_PER_PLAYER_MIN = 1;
const AUTO_EXPORT_MAX_PER_PLAYER_MAX = 50;
const SFTP_POLL_INTERVAL_MIN = 2;
const SFTP_POLL_INTERVAL_MAX = 10;

const MOD_RESTART_DELAY_MIN = 0;
const MOD_RESTART_DELAY_MAX = 30;
const SERVER_AUTO_UPDATE_WARNING_MINUTES_MIN = 0;
const SERVER_AUTO_UPDATE_WARNING_MINUTES_MAX = 60;

const router = express.Router();

const VALID_SETTINGS_KEYS = [
  "rconHost",
  "rconPort",
  "rconPassword",
  "serverPath",
  "serverConfigPath",
  "zomboidDataPath",
  "steamcmdPath",
  "steamUpdateAccount",
  "steamApiKey",
  "serverName",
  "minMemory",
  "maxMemory",
  "serverPort",
  "modCheckInterval",
  "modAutoRestart",
  "modRestartDelay",
  "serverAutoUpdate",
  "serverAutoUpdateWarningMinutes",
  "darkMode",
  "autoReconnect",
  "reconnectInterval",
  // Discord config is owned by /api/discord (discordBotToken,
  // discordAdminRoleId, ...). The old discordEnabled/discordToken/
  // discordAdminRole keys are deliberately NOT listed: nothing reads them, so
  // allowing them here would accept a write that silently never takes effect.
  "discordGuildId",
  "autoStartServer",
  "panelPort",
  "httpsEnabled",
  "httpsPort",
  "httpsKeyPath",
  "httpsCertPath",
  "corsAllowedOrigins",
  "corsAllowAll",
  "corsAllowPrivateNetworks",
  "corsDebug",
  "panelBridgeAutoUpdate",
  "autoExportOnLogin",
  "autoExportMaxPerPlayer",
  // Opt-in external public-IP lookup (api.ipify.org) shown on the dashboard/
  // panel-info — off by default (see serverManager.fetchPublicIp).
  "enablePublicIpLookup",
  // Workshop collection sync — mirrors tracked mods into a Steam collection.
  // steamSessionId / steamLoginSecure are cookie pairs; treated as secrets.
  "workshopCollectionId",
  "workshopCollectionAutoSync",
  "steamSessionId",
  "steamLoginSecure",
  // Chat page Quick Messages presets — array of strings.
  "chatPresets",
  // Dashboard LAN IP override — pick which detected interface to display
  // when the host has more than one (multiple VPN meshes, etc). Empty
  // string clears it back to auto-detect.
  "lanIpAddress",
  "panelBridgeSftpEnabled",
  "panelBridgeSftpHost",
  "panelBridgeSftpPort",
  "panelBridgeSftpUsername",
  "panelBridgeSftpPassword",
  "panelBridgeSftpBridgePath",
  "panelBridgeSftpPollIntervalSeconds",
  "panelBridgeSftpLogPath",
  "panelBridgeSftpConfigPath",
];

const SETTINGS_KEY_CAPABILITY = {
  rconHost: "server.configure",
  rconPort: "server.configure",
  rconPassword: "server.configure",
  serverPath: "servers.manage",
  serverConfigPath: "servers.manage",
  zomboidDataPath: "servers.manage",
  steamApiKey: "server.install",
  steamUpdateAccount: "server.install",
  steamcmdPath: "server.install",
  panelBridgeSftpEnabled: "bridge.setup",
  panelBridgeSftpHost: "bridge.setup",
  panelBridgeSftpPort: "bridge.setup",
  panelBridgeSftpUsername: "bridge.setup",
  panelBridgeSftpPassword: "bridge.setup",
  panelBridgeSftpBridgePath: "bridge.setup",
  panelBridgeSftpPollIntervalSeconds: "bridge.setup",
  panelBridgeSftpLogPath: "bridge.setup",
  panelBridgeSftpConfigPath: "bridge.setup",
  discordGuildId: "integrations.manage",
  workshopCollectionId: "mods.manage",
  workshopCollectionAutoSync: "mods.manage",
  steamSessionId: "mods.manage",
  steamLoginSecure: "mods.manage",
};

const ORIGIN_DELIMITER_REGEX = /[\n,;]+/;
const MAX_CORS_ALLOWED_ORIGINS_LENGTH = 5000;
const MAX_CORS_ALLOWED_ORIGINS = 100;
const MAX_CORS_ORIGIN_LENGTH = 256;

function validateCorsAllowedOrigins(value) {
  if (typeof value !== "string") {
    return "CORS allowed origins must be a string list";
  }

  if (value.length > MAX_CORS_ALLOWED_ORIGINS_LENGTH) {
    return `CORS allowed origins list is too long (max ${MAX_CORS_ALLOWED_ORIGINS_LENGTH} characters)`;
  }

  const rawOrigins = value
    .split(ORIGIN_DELIMITER_REGEX)
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (rawOrigins.length > MAX_CORS_ALLOWED_ORIGINS) {
    return `Too many CORS origins (max ${MAX_CORS_ALLOWED_ORIGINS})`;
  }

  for (const origin of rawOrigins) {
    if (origin.length > MAX_CORS_ORIGIN_LENGTH) {
      return `Origin is too long (max ${MAX_CORS_ORIGIN_LENGTH} chars): ${origin.slice(0, 40)}...`;
    }
    try {
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol)) {
        return `Only http/https origins are allowed: ${origin}`;
      }
    } catch {
      return `Invalid origin format: ${origin}`;
    }
  }

  return null;
}

const maskSensitiveSettings = maskSensitiveObject;

router.get("/app-settings", async (req, res) => {
  try {
    const settings = await getAllSettings();
    res.json({ settings: maskSensitiveSettings(settings) });
  } catch (error) {
    log.error(`Failed to get app settings: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.put("/app-settings", requirePermission("panel.settings"), async (req, res) => {
  try {
    const { settings } = req.body || {};
    log.info(
      `PUT /app-settings — updating ${settings ? Object.keys(settings).length : 0} keys: [${settings ? Object.keys(settings).join(", ") : ""}]`,
    );

    if (!settings || typeof settings !== "object") {
      return res.status(400).json({ error: "Settings are required", code: ErrorCode.CONFIG_APP_SETTINGS_REQUIRED });
    }

    const FEATURE_GATED_FIELDS = {
      panelBridgeSftpPort: "panelBridgeSftpEnabled",
      panelBridgeSftpPollIntervalSeconds: "panelBridgeSftpEnabled",
      httpsCertPath: "httpsEnabled",
      httpsKeyPath: "httpsEnabled",
      httpsPort: "httpsEnabled",
      modRestartDelay: "modAutoRestart",
      serverAutoUpdateWarningMinutes: "serverAutoUpdate",
      autoExportMaxPerPlayer: "autoExportOnLogin",
      reconnectInterval: "autoReconnect",
    };

    const effectiveFlagCache = new Map();
    function getEffectiveFlag(flagKey) {
      if (!effectiveFlagCache.has(flagKey)) {
        effectiveFlagCache.set(
          flagKey,
          Object.prototype.hasOwnProperty.call(settings, flagKey)
            ? Promise.resolve(Boolean(settings[flagKey]))
            : getSetting(flagKey).then(Boolean),
        );
      }
      return effectiveFlagCache.get(flagKey);
    }

    const validEntries = [];
    for (const [key, value] of Object.entries(settings)) {
      if (!VALID_SETTINGS_KEYS.includes(key)) {
        log.warn(`Invalid setting key rejected: ${key}`);
        continue;
      }

      const gateFlag = FEATURE_GATED_FIELDS[key];
      if (gateFlag && !(await getEffectiveFlag(gateFlag))) {
        validEntries.push([key, value]);
        continue;
      }

      if (key === "corsAllowedOrigins") {
        const corsValidationError = validateCorsAllowedOrigins(value);
        if (corsValidationError) {
          return res.status(400).json({
            error: corsValidationError,
            code: ErrorCode.CONFIG_INVALID_CORS_ORIGINS,
            params: sanitizeErrorParams({ reason: corsValidationError }),
          });
        }
      }

      if (
        key === "serverName" &&
        !/^[a-zA-Z0-9_-][a-zA-Z0-9_\- ]*[a-zA-Z0-9_-]$|^[a-zA-Z0-9_-]$/.test(
          String(value),
        )
      ) {
        return res.status(400).json({
          error:
            "Server name may only contain letters, numbers, spaces, underscores and hyphens (and can't start or end with a space).",
          code: ErrorCode.CONFIG_INVALID_SERVER_NAME,
        });
      }

      if (
        key === "modCheckInterval" &&
        minutesToCheckIntervalMs(value) === null
      ) {
        return res.status(400).json({
          error: `modCheckInterval must be a whole number of minutes from ${MOD_CHECK_INTERVAL_MINUTES_MIN} to ${MOD_CHECK_INTERVAL_MINUTES_MAX}`,
          code: ErrorCode.CONFIG_INVALID_MOD_CHECK_INTERVAL,
        });
      }

      if (key === "modRestartDelay") {
        const modRestartDelayCheck = requireIntInRange(
          value,
          MOD_RESTART_DELAY_MIN,
          MOD_RESTART_DELAY_MAX,
          "Mod restart delay (minutes)",
        );
        if (!modRestartDelayCheck.ok) {
          return res.status(400).json({ error: modRestartDelayCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: modRestartDelayCheck.message }) });
        }
      }

      if (key === "serverAutoUpdateWarningMinutes") {
        const warningMinutesCheck = requireIntInRange(
          value,
          SERVER_AUTO_UPDATE_WARNING_MINUTES_MIN,
          SERVER_AUTO_UPDATE_WARNING_MINUTES_MAX,
          "Server auto-update warning (minutes)",
        );
        if (!warningMinutesCheck.ok) {
          return res.status(400).json({ error: warningMinutesCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: warningMinutesCheck.message }) });
        }
      }

      if (key === "lanIpAddress" && value !== "" && net.isIP(value) !== 4) {
        return res
          .status(400)
          .json({ error: "lanIpAddress must be an IPv4 address or empty", code: ErrorCode.CONFIG_INVALID_LAN_IP });
      }

      if (
        [
          "corsAllowAll",
          "corsAllowPrivateNetworks",
          "corsDebug",
          "panelBridgeAutoUpdate",
          "autoExportOnLogin",
          "enablePublicIpLookup",
          // The other 8 boolean-shaped keys in VALID_SETTINGS_KEYS, added in
          // the same pass as rconPort/serverPort/min+maxMemory/panelPort
          // below -- accepted any truthy/falsy JS value with no gate at all
          // until now. See 2026-08-23 config.js numeric-field audit.
          "modAutoRestart",
          "serverAutoUpdate",
          "darkMode",
          "autoReconnect",
          "httpsEnabled",
          "autoStartServer",
          "workshopCollectionAutoSync",
          "panelBridgeSftpEnabled",
        ].includes(key) &&
        typeof value !== "boolean"
      ) {
        return res.status(400).json({
          error: `${key} must be true or false`,
          code: ErrorCode.CONFIG_INVALID_BOOLEAN_FIELD,
          params: sanitizeErrorParams({ field: key }),
        });
      }

      if (
        (key === "httpsCertPath" || key === "httpsKeyPath") &&
        value !== ""
      ) {
        if (typeof value !== "string") {
          return res.status(400).json({
            error: `${key} must be a string`,
            code: ErrorCode.CONFIG_HTTPS_PATH_NOT_STRING,
            params: sanitizeErrorParams({ field: key }),
          });
        }
        let stat;
        try {
          stat = fs.statSync(value);
        } catch {
          return res.status(400).json({
            error: `${key} does not point to a file that exists: ${value}`,
            code: ErrorCode.CONFIG_HTTPS_PATH_NOT_FOUND,
            params: sanitizeErrorParams({ field: key, value }),
          });
        }
        if (!stat.isFile()) {
          return res.status(400).json({
            error: `${key} must be a file, not a directory: ${value}`,
            code: ErrorCode.CONFIG_HTTPS_PATH_NOT_A_FILE,
            params: sanitizeErrorParams({ field: key, value }),
          });
        }
        try {
          fs.accessSync(value, fs.constants.R_OK);
        } catch {
          return res.status(400).json({
            error: `${key} exists but is not readable by the panel: ${value}`,
            code: ErrorCode.CONFIG_HTTPS_PATH_NOT_READABLE,
            params: sanitizeErrorParams({ field: key, value }),
          });
        }
      }

      if (key === "httpsPort") {
        const httpsPortCheck = requireIntInRange(value, BIND_PORT_MIN, BIND_PORT_MAX, "HTTPS port");
        if (!httpsPortCheck.ok) {
          return res.status(400).json({ error: httpsPortCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: httpsPortCheck.message }) });
        }
        const panelPort = await getSetting("panelPort");
        if (panelPort && httpsPortCheck.value === Number(panelPort)) {
          return res.status(400).json({
            error: `HTTPS port cannot be the same as the panel's HTTP port (${panelPort})`,
            code: ErrorCode.CONFIG_HTTPS_PORT_MATCHES_PANEL_PORT,
            params: sanitizeErrorParams({ panelPort }),
          });
        }
      }

      if (key === "panelPort") {
        const panelPortCheck = requireIntInRange(value, BIND_PORT_MIN, BIND_PORT_MAX, "Panel port");
        if (!panelPortCheck.ok) {
          return res.status(400).json({ error: panelPortCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: panelPortCheck.message }) });
        }
        const httpsPort = await getSetting("httpsPort");
        if (httpsPort && panelPortCheck.value === Number(httpsPort)) {
          return res.status(400).json({
            error: `panelPort cannot be the same as the panel's HTTPS port (${httpsPort})`,
            code: ErrorCode.CONFIG_PANEL_PORT_MATCHES_HTTPS_PORT,
            params: sanitizeErrorParams({ httpsPort }),
          });
        }
      }

      if (key === "rconPort") {
        const rconPortCheck = requireIntInRange(value, BIND_PORT_MIN, BIND_PORT_MAX, "RCON port");
        if (!rconPortCheck.ok) {
          return res.status(400).json({ error: rconPortCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: rconPortCheck.message }) });
        }
      }

      if (key === "serverPort") {
        const serverPortCheck = requireIntInRange(value, BIND_PORT_MIN, GAME_PORT_MAX, "Game port");
        if (!serverPortCheck.ok) {
          return res.status(400).json({ error: serverPortCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: serverPortCheck.message }) });
        }
      }

      if (key === "panelBridgeSftpPort") {
        const sftpPortCheck = requireIntInRange(
          value,
          DESTINATION_PORT_MIN,
          DESTINATION_PORT_MAX,
          "SFTP port",
        );
        if (!sftpPortCheck.ok) {
          return res.status(400).json({ error: sftpPortCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: sftpPortCheck.message }) });
        }
      }

      if (key === "panelBridgeSftpPollIntervalSeconds") {
        const sftpPollCheck = requireIntInRange(
          value,
          SFTP_POLL_INTERVAL_MIN,
          SFTP_POLL_INTERVAL_MAX,
          "SFTP sync interval (seconds)",
        );
        if (!sftpPollCheck.ok) {
          return res.status(400).json({ error: sftpPollCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: sftpPollCheck.message }) });
        }
      }

      if (key === "minMemory") {
        const minMemoryCheck = requireIntInRange(value, MEMORY_GB_MIN, MIN_MEMORY_GB_MAX, "Minimum memory (GB)");
        if (!minMemoryCheck.ok) {
          return res.status(400).json({ error: minMemoryCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: minMemoryCheck.message }) });
        }
      }

      if (key === "maxMemory") {
        const maxMemoryCheck = requireIntInRange(value, MEMORY_GB_MIN, MAX_MEMORY_GB_MAX, "Maximum memory (GB)");
        if (!maxMemoryCheck.ok) {
          return res.status(400).json({ error: maxMemoryCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: maxMemoryCheck.message }) });
        }
      }

      if (key === "autoExportMaxPerPlayer") {
        const autoExportMaxCheck = requireIntInRange(value, AUTO_EXPORT_MAX_PER_PLAYER_MIN, AUTO_EXPORT_MAX_PER_PLAYER_MAX, "Auto-export copies kept");
        if (!autoExportMaxCheck.ok) {
          return res.status(400).json({ error: autoExportMaxCheck.message, code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD, params: sanitizeErrorParams({ message: autoExportMaxCheck.message }) });
        }
      }

      if (key === "reconnectInterval") {
        const interval = parseBoundedInteger(value, null, 1, 60);
        if (interval === null) {
          const message = "reconnectInterval must be a whole number from 1 to 60";
          return res.status(400).json({
            error: message,
            code: ErrorCode.CONFIG_INVALID_NUMERIC_FIELD,
            params: sanitizeErrorParams({ message }),
          });
        }
      }

      if (key === "chatPresets") {
        if (!Array.isArray(value)) {
          return res
            .status(400)
            .json({ error: "chatPresets must be an array", code: ErrorCode.CONFIG_CHAT_PRESETS_NOT_ARRAY });
        }
        if (value.length > 50) {
          return res
            .status(400)
            .json({ error: "chatPresets supports up to 50 entries", code: ErrorCode.CONFIG_CHAT_PRESETS_TOO_MANY });
        }
        if (!value.every((v) => typeof v === "string" && v.length <= 500)) {
          return res.status(400).json({
            error: "chatPresets entries must be strings up to 500 characters",
            code: ErrorCode.CONFIG_CHAT_PRESETS_INVALID_ENTRY,
          });
        }
      }

      validEntries.push([key, value]);
    }

    const filtered = validEntries.filter(([key, value]) => {
      if (SENSITIVE_FIELD_RE.test(key) && isMaskedSecret(value)) {
        log.info(
          `Preserving stored value for sensitive key "${key}" (masked input ignored)`,
        );
        return false;
      }
      return true;
    });

    const touchesGovernedKey = filtered.some(
      ([key]) => key in SETTINGS_KEY_CAPABILITY,
    );
    const currentSettings = touchesGovernedKey ? await getAllSettings() : null;
    const missingCapabilities = [];
    let callerCapabilities = null;
    for (const [key, value] of filtered) {
      const requiredCapability = SETTINGS_KEY_CAPABILITY[key];
      if (!requiredCapability) continue;
      if (JSON.stringify(currentSettings[key]) === JSON.stringify(value)) {
        continue;
      }
      if (callerCapabilities === null) {
        const role = req.user ? await getRoleByName(req.user.role) : null;
        callerCapabilities = Array.isArray(role?.capabilities)
          ? role.capabilities
          : [];
      }
      if (!callerCapabilities.includes(requiredCapability)) {
        missingCapabilities.push({ key, requiredCapability });
      }
    }
    if (missingCapabilities.length > 0) {
      const detail = missingCapabilities
        .map((m) => `"${m.key}" needs ${m.requiredCapability}`)
        .join(", ");
      return res.status(403).json({
        error: `Cannot change ${detail} without holding that capability yourself.`,
        code: ErrorCode.CONFIG_APP_SETTINGS_CAPABILITY_REQUIRED,
        params: sanitizeErrorParams({ detail }),
        missing: missingCapabilities,
      });
    }

    const steamSessionIdEntry = filtered.find(
      ([key]) => key === "steamSessionId",
    );
    const steamLoginSecureEntry = filtered.find(
      ([key]) => key === "steamLoginSecure",
    );
    if (steamSessionIdEntry || steamLoginSecureEntry) {
      await setSteamSessionCredentials(
        steamSessionIdEntry?.[1],
        steamLoginSecureEntry?.[1],
      );
    }

    for (const [key, value] of filtered) {
      if (
        key === "modCheckInterval" ||
        key === "steamSessionId" ||
        key === "steamLoginSecure"
      ) continue;
      await setSetting(key, value);
    }

    const modCheckIntervalEntry = filtered.find(
      ([key]) => key === "modCheckInterval",
    );
    if (modCheckIntervalEntry) {
      const [, minutes] = modCheckIntervalEntry;
      const modChecker = req.app.get("modChecker");
      if (modChecker?.setCheckIntervalMinutes) {
        await modChecker.setCheckIntervalMinutes(minutes);
      } else {
        await setSetting("modCheckInterval", Number(minutes));
      }
    }

    const modChecker = req.app.get("modChecker");
    const autoRestartEntry = filtered.find(
      ([key]) => key === "modAutoRestart",
    );
    if (autoRestartEntry && modChecker?.setUpdateCallback) {
      const [, enabled] = autoRestartEntry;
      await modChecker.setUpdateCallback(
        enabled
          ? async (updatedMods) => modChecker.handleModUpdate(updatedMods)
          : null,
      );
    }

    const restartDelayEntry = filtered.find(
      ([key]) => key === "modRestartDelay",
    );
    if (restartDelayEntry && modChecker?.setRestartOptions) {
      const [, warningMinutes] = restartDelayEntry;
      await modChecker.setRestartOptions({ warningMinutes });
    }

    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");
    const reloadWarnings = [];
    if (serverManager?.reloadConfig) {
      try {
        await serverManager.reloadConfig();
      } catch (reloadErr) {
        log.warn(
          `serverManager reload failed after settings save: ${reloadErr.message}`,
        );
        reloadWarnings.push(
          "Server manager failed to reload — restart may be required",
        );
      }
    }
    if (rconService?.loadConfig) {
      try {
        rconService.configLoaded = false;
        await rconService.loadConfig();
      } catch (reloadErr) {
        log.warn(
          `rconService reload failed after settings save: ${reloadErr.message}`,
        );
        reloadWarnings.push(
          "RCON service failed to reload — reconnect may be required",
        );
      }
    }
    const refreshCorsConfig = req.app.get("refreshCorsConfig");
    if (typeof refreshCorsConfig === "function") {
      try {
        await refreshCorsConfig();
      } catch (reloadErr) {
        log.warn(
          `CORS config reload failed after settings save: ${reloadErr.message}`,
        );
        reloadWarnings.push(
          "CORS settings could not be reloaded — panel restart may be required",
        );
      }
    }

    const response = { success: true, message: "Settings saved" };
    if (reloadWarnings.length) response.warnings = reloadWarnings;
    res.json(response);
  } catch (error) {
    log.error(`Failed to save app settings: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/cors-debug", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const getCorsDebugSnapshot = req.app.get("getCorsDebugSnapshot");
    if (typeof getCorsDebugSnapshot !== "function") {
      return res
        .status(500)
        .json({ error: "CORS diagnostics are not available", code: ErrorCode.CONFIG_CORS_DIAGNOSTICS_UNAVAILABLE });
    }
    res.json({ diagnostics: getCorsDebugSnapshot() });
  } catch (error) {
    log.error(`Failed to get CORS diagnostics: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/cors-debug/reload", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const refreshCorsConfig = req.app.get("refreshCorsConfig");
    if (typeof refreshCorsConfig !== "function") {
      return res
        .status(500)
        .json({ error: "CORS config reload is not available", code: ErrorCode.CONFIG_CORS_RELOAD_UNAVAILABLE });
    }
    const diagnostics = await refreshCorsConfig();
    res.json({ success: true, diagnostics });
  } catch (error) {
    log.error(`Failed to reload CORS config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/cors-debug/blocked", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const clearCorsBlockedOrigins = req.app.get("clearCorsBlockedOrigins");
    const getCorsDebugSnapshot = req.app.get("getCorsDebugSnapshot");
    if (
      typeof clearCorsBlockedOrigins !== "function" ||
      typeof getCorsDebugSnapshot !== "function"
    ) {
      return res
        .status(500)
        .json({ error: "CORS diagnostics are not available", code: ErrorCode.CONFIG_CORS_DIAGNOSTICS_UNAVAILABLE });
    }

    clearCorsBlockedOrigins();
    res.json({ success: true, diagnostics: getCorsDebugSnapshot() });
  } catch (error) {
    log.error(`Failed to clear blocked CORS origins: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/test-rcon", requirePermission("server.configure"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");

    const connected = await rconService.connect();

    if (connected) {
      try {
        const probe = await rconService.execute("players", { skipLog: true });
        if (!probe?.success) {
          res.json({
            success: true,
            message:
              "Connected but command failed: " + sanitizeError(probe?.error),
            connected: true,
            warning: true,
          });
          return;
        }
        res.json({
          success: true,
          message: "RCON connection successful",
          connected: true,
        });
      } catch (cmdError) {
        res.json({
          success: true,
          message:
            "Connected but command failed: " + sanitizeError(cmdError.message),
          connected: true,
          warning: true,
        });
      }
    } else {
      const { host: configuredHost, port: configuredPort } =
        rconService.getConfig();
      const reachable = await checkTcpReachable(
        configuredHost,
        configuredPort,
        RCON_USER_ACTION_TIMEOUT_MS,
      );
      if (!reachable) {
        return res.json({
          success: false,
          error: "unreachable",
          detail: RCON_UNREACHABLE_DETAIL,
          message: RCON_UNREACHABLE_DETAIL,
          connected: false,
          code: ErrorCode.RCON_CONNECT_UNREACHABLE,
        });
      }
      res.json({
        success: false,
        error: "auth_failed",
        detail: RCON_AUTH_FAILED_DETAIL,
        message: RCON_AUTH_FAILED_DETAIL,
        connected: false,
        code: ErrorCode.RCON_CONNECT_AUTH_FAILED,
      });
    }
  } catch (error) {
    log.error(`RCON test failed: ${error.message}`);
    res.status(500).json({
      success: false,
      error: sanitizeError(error.message),
      connected: false,
    });
  }
});

export default router;
