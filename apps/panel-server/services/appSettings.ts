import fs from "fs";
import net from "net";
import {
  getAllSettings,
  getRoleByName,
  getSetting,
  setSetting,
} from "../database/init.ts";
import {
  sanitizeErrorParams,
  SENSITIVE_FIELD_RE,
  isMaskedSecret,
} from "../utils/sanitize.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import { parseBoundedInteger } from "../utils/queryNumbers.ts";
import { setSteamSessionCredentials } from "./steamSessionCredentials.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("AppSettings");

const AUTO_EXPORT_MAX_PER_PLAYER_MIN = 1;
const AUTO_EXPORT_MAX_PER_PLAYER_MAX = 50;
const SFTP_POLL_INTERVAL_MIN = 2;
const SFTP_POLL_INTERVAL_MAX = 10;
const MOD_RESTART_DELAY_MIN = 0;
const MOD_RESTART_DELAY_MAX = 30;
const SERVER_AUTO_UPDATE_WARNING_MINUTES_MIN = 0;
const SERVER_AUTO_UPDATE_WARNING_MINUTES_MAX = 60;
const MOD_CHECK_INTERVAL_MINUTES_MIN = 1;
const MOD_CHECK_INTERVAL_MINUTES_MAX = 120;

const BIND_PORT_MIN = 1024;
const BIND_PORT_MAX = 65535;
const GAME_PORT_MAX = BIND_PORT_MAX - 1;
const DESTINATION_PORT_MIN = 1;
const DESTINATION_PORT_MAX = 65535;
const MEMORY_GB_MIN = 1;
const MIN_MEMORY_GB_MAX = 64;
const MAX_MEMORY_GB_MAX = 128;

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
  "enablePublicIpLookup",
  "workshopCollectionId",
  "workshopCollectionAutoSync",
  "steamSessionId",
  "steamLoginSecure",
  "chatPresets",
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
] as const;

const SETTINGS_KEY_CAPABILITY: Record<string, string> = {
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

const FEATURE_GATED_FIELDS: Record<string, string> = {
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

const ORIGIN_DELIMITER_REGEX = /[\n,;]+/;
const MAX_CORS_ALLOWED_ORIGINS_LENGTH = 5000;
const MAX_CORS_ALLOWED_ORIGINS = 100;
const MAX_CORS_ORIGIN_LENGTH = 256;

const BOOLEAN_SETTINGS = new Set([
  "corsAllowAll",
  "corsAllowPrivateNetworks",
  "corsDebug",
  "panelBridgeAutoUpdate",
  "autoExportOnLogin",
  "enablePublicIpLookup",
  "modAutoRestart",
  "serverAutoUpdate",
  "darkMode",
  "autoReconnect",
  "httpsEnabled",
  "autoStartServer",
  "workshopCollectionAutoSync",
  "panelBridgeSftpEnabled",
]);

type SettingEntry = [string, unknown];
type IntegerValidation =
  { ok: false; message: string } | { ok: true; value: number };

function minutesToCheckIntervalMs(minutes: unknown): number | null {
  const value = Number(minutes);
  if (
    !Number.isInteger(value) ||
    value < MOD_CHECK_INTERVAL_MINUTES_MIN ||
    value > MOD_CHECK_INTERVAL_MINUTES_MAX
  ) {
    return null;
  }
  return value * 60 * 1000;
}

type RuntimeComponent = Record<string, any> | null | undefined;

export type AppSettingsRuntime = {
  modChecker?: RuntimeComponent;
  serverManager?: RuntimeComponent;
  rconService?: RuntimeComponent;
  refreshCorsConfig?: (() => Promise<unknown>) | (() => unknown);
};

export class AppSettingsError extends Error {
  readonly status: number;
  readonly code: string;
  readonly params?: unknown;
  readonly missing?: Array<{ key: string; requiredCapability: string }>;

  constructor(
    message: string,
    code: string,
    options: {
      status?: number;
      params?: unknown;
      missing?: Array<{ key: string; requiredCapability: string }>;
    } = {},
  ) {
    super(message);
    this.name = "AppSettingsError";
    this.status = options.status ?? 400;
    this.code = code;
    this.params = options.params;
    this.missing = options.missing;
  }
}

function invalid(message: string, code: string, params?: unknown): never {
  throw new AppSettingsError(message, code, { params });
}

function requireIntInRange(
  value: unknown,
  min: number,
  max: number,
  fieldLabel: string,
): IntegerValidation {
  const textValue = typeof value === "string" ? value.trim() : null;
  const numberValue =
    typeof value === "number"
      ? value
      : textValue && /^[+-]?\d+$/.test(textValue)
        ? Number(textValue)
        : Number.NaN;
  if (
    !Number.isInteger(numberValue) ||
    numberValue < min ||
    numberValue > max
  ) {
    return {
      ok: false,
      message: `${fieldLabel} must be a whole number between ${min} and ${max}.`,
    };
  }
  return { ok: true, value: numberValue };
}

function validateCorsAllowedOrigins(value: unknown): string | null {
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

export async function saveAppSettings(
  input: unknown,
  options: { userRole?: string; runtime?: AppSettingsRuntime } = {},
): Promise<{ success: true; message: string; warnings?: string[] }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppSettingsError(
      "Settings are required",
      ErrorCode.CONFIG_APP_SETTINGS_REQUIRED,
    );
  }

  const settings = input as Record<string, unknown>;
  const runtime = options.runtime ?? {};
  const effectiveFlagCache = new Map<string, Promise<boolean>>();
  const getEffectiveFlag = (flagKey: string): Promise<boolean> => {
    if (!effectiveFlagCache.has(flagKey)) {
      effectiveFlagCache.set(
        flagKey,
        Object.prototype.hasOwnProperty.call(settings, flagKey)
          ? Promise.resolve(Boolean(settings[flagKey]))
          : getSetting(flagKey).then(Boolean),
      );
    }
    return effectiveFlagCache.get(flagKey)!;
  };

  const validEntries: SettingEntry[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (!(VALID_SETTINGS_KEYS as readonly string[]).includes(key)) {
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
        invalid(
          corsValidationError,
          ErrorCode.CONFIG_INVALID_CORS_ORIGINS,
          sanitizeErrorParams({ reason: corsValidationError }),
        );
      }
    }

    if (
      key === "serverName" &&
      !/^[a-zA-Z0-9_-][a-zA-Z0-9_\- ]*[a-zA-Z0-9_-]$|^[a-zA-Z0-9_-]$/.test(
        String(value),
      )
    ) {
      invalid(
        "Server name may only contain letters, numbers, spaces, underscores and hyphens (and can't start or end with a space).",
        ErrorCode.CONFIG_INVALID_SERVER_NAME,
      );
    }

    if (
      key === "modCheckInterval" &&
      minutesToCheckIntervalMs(value) === null
    ) {
      invalid(
        `modCheckInterval must be a whole number of minutes from ${MOD_CHECK_INTERVAL_MINUTES_MIN} to ${MOD_CHECK_INTERVAL_MINUTES_MAX}`,
        ErrorCode.CONFIG_INVALID_MOD_CHECK_INTERVAL,
      );
    }

    if (key === "modRestartDelay") {
      const check = requireIntInRange(
        value,
        MOD_RESTART_DELAY_MIN,
        MOD_RESTART_DELAY_MAX,
        "Mod restart delay (minutes)",
      );
      if (!check.ok) {
        invalid(
          check.message,
          ErrorCode.CONFIG_INVALID_NUMERIC_FIELD,
          sanitizeErrorParams({ message: check.message }),
        );
      }
    }

    if (key === "serverAutoUpdateWarningMinutes") {
      const check = requireIntInRange(
        value,
        SERVER_AUTO_UPDATE_WARNING_MINUTES_MIN,
        SERVER_AUTO_UPDATE_WARNING_MINUTES_MAX,
        "Server auto-update warning (minutes)",
      );
      if (!check.ok) {
        invalid(
          check.message,
          ErrorCode.CONFIG_INVALID_NUMERIC_FIELD,
          sanitizeErrorParams({ message: check.message }),
        );
      }
    }

    if (
      key === "lanIpAddress" &&
      (typeof value !== "string" || (value !== "" && net.isIP(value) !== 4))
    ) {
      invalid(
        "lanIpAddress must be an IPv4 address or empty",
        ErrorCode.CONFIG_INVALID_LAN_IP,
      );
    }

    if (BOOLEAN_SETTINGS.has(key) && typeof value !== "boolean") {
      invalid(
        `${key} must be true or false`,
        ErrorCode.CONFIG_INVALID_BOOLEAN_FIELD,
        sanitizeErrorParams({ field: key }),
      );
    }

    if ((key === "httpsCertPath" || key === "httpsKeyPath") && value !== "") {
      if (typeof value !== "string") {
        invalid(
          `${key} must be a string`,
          ErrorCode.CONFIG_HTTPS_PATH_NOT_STRING,
          sanitizeErrorParams({ field: key }),
        );
      }
      let stat;
      try {
        stat = fs.statSync(value as string);
      } catch {
        invalid(
          `${key} does not point to a file that exists: ${value}`,
          ErrorCode.CONFIG_HTTPS_PATH_NOT_FOUND,
          sanitizeErrorParams({ field: key, value }),
        );
      }
      if (!stat.isFile()) {
        invalid(
          `${key} must be a file, not a directory: ${value}`,
          ErrorCode.CONFIG_HTTPS_PATH_NOT_A_FILE,
          sanitizeErrorParams({ field: key, value }),
        );
      }
      try {
        fs.accessSync(value as string, fs.constants.R_OK);
      } catch {
        invalid(
          `${key} exists but is not readable by the panel: ${value}`,
          ErrorCode.CONFIG_HTTPS_PATH_NOT_READABLE,
          sanitizeErrorParams({ field: key, value }),
        );
      }
    }

    if (key === "httpsPort") {
      const check = requireIntInRange(
        value,
        BIND_PORT_MIN,
        BIND_PORT_MAX,
        "HTTPS port",
      );
      if (!check.ok) {
        invalid(
          check.message,
          ErrorCode.CONFIG_INVALID_NUMERIC_FIELD,
          sanitizeErrorParams({ message: check.message }),
        );
      }
      const panelPort = await getSetting("panelPort");
      if (panelPort && check.value === Number(panelPort)) {
        invalid(
          `HTTPS port cannot be the same as the panel's HTTP port (${panelPort})`,
          ErrorCode.CONFIG_HTTPS_PORT_MATCHES_PANEL_PORT,
          sanitizeErrorParams({ panelPort }),
        );
      }
    }

    if (key === "panelPort") {
      const check = requireIntInRange(
        value,
        BIND_PORT_MIN,
        BIND_PORT_MAX,
        "Panel port",
      );
      if (!check.ok) {
        invalid(
          check.message,
          ErrorCode.CONFIG_INVALID_NUMERIC_FIELD,
          sanitizeErrorParams({ message: check.message }),
        );
      }
      const httpsPort = await getSetting("httpsPort");
      if (httpsPort && check.value === Number(httpsPort)) {
        invalid(
          `panelPort cannot be the same as the panel's HTTPS port (${httpsPort})`,
          ErrorCode.CONFIG_PANEL_PORT_MATCHES_HTTPS_PORT,
          sanitizeErrorParams({ httpsPort }),
        );
      }
    }

    const integerFields: Array<[string, number, number, string]> = [
      ["rconPort", BIND_PORT_MIN, BIND_PORT_MAX, "RCON port"],
      ["serverPort", BIND_PORT_MIN, GAME_PORT_MAX, "Game port"],
      [
        "panelBridgeSftpPort",
        DESTINATION_PORT_MIN,
        DESTINATION_PORT_MAX,
        "SFTP port",
      ],
      [
        "panelBridgeSftpPollIntervalSeconds",
        SFTP_POLL_INTERVAL_MIN,
        SFTP_POLL_INTERVAL_MAX,
        "SFTP sync interval (seconds)",
      ],
      ["minMemory", MEMORY_GB_MIN, MIN_MEMORY_GB_MAX, "Minimum memory (GB)"],
      ["maxMemory", MEMORY_GB_MIN, MAX_MEMORY_GB_MAX, "Maximum memory (GB)"],
      [
        "autoExportMaxPerPlayer",
        AUTO_EXPORT_MAX_PER_PLAYER_MIN,
        AUTO_EXPORT_MAX_PER_PLAYER_MAX,
        "Auto-export copies kept",
      ],
    ];
    const integerField = integerFields.find(([field]) => field === key);
    if (integerField) {
      const [, min, max, label] = integerField;
      const check = requireIntInRange(value, min, max, label);
      if (!check.ok) {
        invalid(
          check.message,
          ErrorCode.CONFIG_INVALID_NUMERIC_FIELD,
          sanitizeErrorParams({ message: check.message }),
        );
      }
    }

    if (key === "reconnectInterval") {
      const interval = parseBoundedInteger(value, null, 1, 60);
      if (interval === null) {
        const message = "reconnectInterval must be a whole number from 1 to 60";
        invalid(
          message,
          ErrorCode.CONFIG_INVALID_NUMERIC_FIELD,
          sanitizeErrorParams({ message }),
        );
      }
    }

    if (key === "chatPresets") {
      if (!Array.isArray(value)) {
        invalid(
          "chatPresets must be an array",
          ErrorCode.CONFIG_CHAT_PRESETS_NOT_ARRAY,
        );
      }
      if (value.length > 50) {
        invalid(
          "chatPresets supports up to 50 entries",
          ErrorCode.CONFIG_CHAT_PRESETS_TOO_MANY,
        );
      }
      if (
        !value.every(
          (entry) => typeof entry === "string" && entry.length <= 500,
        )
      ) {
        invalid(
          "chatPresets entries must be strings up to 500 characters",
          ErrorCode.CONFIG_CHAT_PRESETS_INVALID_ENTRY,
        );
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
  const missingCapabilities: Array<{
    key: string;
    requiredCapability: string;
  }> = [];
  let callerCapabilities: string[] | null = null;
  for (const [key, value] of filtered) {
    const requiredCapability = SETTINGS_KEY_CAPABILITY[key];
    if (!requiredCapability) continue;
    if (JSON.stringify(currentSettings?.[key]) === JSON.stringify(value))
      continue;
    if (callerCapabilities === null) {
      const role = await getRoleByName(options.userRole ?? "");
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
      .map((item) => `"${item.key}" needs ${item.requiredCapability}`)
      .join(", ");
    throw new AppSettingsError(
      `Cannot change ${detail} without holding that capability yourself.`,
      ErrorCode.CONFIG_APP_SETTINGS_CAPABILITY_REQUIRED,
      {
        status: 403,
        params: sanitizeErrorParams({ detail }),
        missing: missingCapabilities,
      },
    );
  }

  const steamSessionIdEntry = filtered.find(
    ([key]) => key === "steamSessionId",
  );
  const steamLoginSecureEntry = filtered.find(
    ([key]) => key === "steamLoginSecure",
  );
  if (steamSessionIdEntry || steamLoginSecureEntry) {
    await setSteamSessionCredentials(
      steamSessionIdEntry?.[1] as string | null | undefined,
      steamLoginSecureEntry?.[1] as string | null | undefined,
    );
  }

  for (const [key, value] of filtered) {
    if (
      key === "modCheckInterval" ||
      key === "steamSessionId" ||
      key === "steamLoginSecure"
    )
      continue;
    await setSetting(key, value);
  }

  const modChecker = runtime.modChecker;
  const modCheckIntervalEntry = filtered.find(
    ([key]) => key === "modCheckInterval",
  );
  if (modCheckIntervalEntry) {
    const [, minutes] = modCheckIntervalEntry;
    if (modChecker?.setCheckIntervalMinutes) {
      await modChecker.setCheckIntervalMinutes(minutes);
    } else {
      await setSetting("modCheckInterval", Number(minutes));
    }
  }

  const autoRestartEntry = filtered.find(([key]) => key === "modAutoRestart");
  if (autoRestartEntry && modChecker?.setUpdateCallback) {
    const [, enabled] = autoRestartEntry;
    await modChecker.setUpdateCallback(
      enabled
        ? async (updatedMods: unknown[]) =>
            modChecker.handleModUpdate(updatedMods)
        : null,
    );
  }

  const restartDelayEntry = filtered.find(([key]) => key === "modRestartDelay");
  if (restartDelayEntry && modChecker?.setRestartOptions) {
    const [, warningMinutes] = restartDelayEntry;
    await modChecker.setRestartOptions({ warningMinutes });
  }

  const reloadWarnings: string[] = [];
  if (runtime.serverManager?.reloadConfig) {
    try {
      await runtime.serverManager.reloadConfig();
    } catch (error: unknown) {
      log.warn(
        `serverManager reload failed after settings save: ${String(error)}`,
      );
      reloadWarnings.push(
        "Server manager failed to reload — restart may be required",
      );
    }
  }
  if (runtime.rconService?.loadConfig) {
    try {
      runtime.rconService.configLoaded = false;
      await runtime.rconService.loadConfig();
    } catch (error: unknown) {
      log.warn(
        `rconService reload failed after settings save: ${String(error)}`,
      );
      reloadWarnings.push(
        "RCON service failed to reload — reconnect may be required",
      );
    }
  }
  if (runtime.refreshCorsConfig) {
    try {
      await runtime.refreshCorsConfig();
    } catch (error: unknown) {
      log.warn(
        `CORS config reload failed after settings save: ${String(error)}`,
      );
      reloadWarnings.push(
        "CORS settings could not be reloaded — panel restart may be required",
      );
    }
  }

  return {
    success: true,
    message: "Settings saved",
    ...(reloadWarnings.length ? { warnings: reloadWarnings } : {}),
  };
}
