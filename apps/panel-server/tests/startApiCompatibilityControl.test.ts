import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const controlNames = [
    "getGameServerStatus",
    "getNetworkInterfaces",
    "getManagedServers",
    "getActiveManagedServer",
    "getManagedServersStatus",
    "getManagedServersRconStatus",
    "getActiveComposedStatus",
    "getManagedServer",
    "getLifecycleTemplate",
    "getDiscoveredMounts",
    "createServerFromDiscovery",
    "createManagedServer",
    "updateManagedServer",
    "deleteManagedServer",
    "activateManagedServer",
    "activateManagedLifecycleProvider",
    "startServer",
    "stopServer",
    "forceStopServer",
    "restartServer",
    "saveGameWorld",
    "sendServerMessage",
    "startRain",
    "stopRain",
    "startStorm",
    "stopWeather",
    "triggerChopper",
    "triggerGunshot",
    "triggerLightning",
    "triggerThunder",
    "createHorde",
    "alarm",
    "removeZombies",
    "reloadLua",
    "setLogLevel",
    "setServerStats",
    "releaseSafehouse",
    "getPlayers",
    "kickPlayer",
    "banPlayer",
    "unbanPlayer",
    "addToWhitelist",
    "removeFromWhitelist",
    "teleportPlayer",
    "addPlayerItem",
    "addPlayerXp",
    "addPlayerVehicle",
    "addPlayerVehicleAt",
    "setGodMode",
    "setInvisible",
    "setNoclip",
    "getPlayerVehicles",
    "getPlayerPerks",
    "getPlayerAccessLevels",
    "setAccessLevel",
    "getSteamIdBans",
    "banSteamId",
    "unbanSteamId",
    "setVoiceBan",
    "addRconUser",
    "addAllToWhitelist",
    "addAllowedSteamId",
    "removeAllowedSteamId",
    "getWhitelist",
  ];
  const control: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of controlNames) {
    const implementation = vi.fn(async (data: unknown) => ({
      handledBy: name,
      data,
    }));
    control[name] = Object.assign(implementation, {
      __executeImplementation: implementation,
    });
  }

  const resource = (name: string) => {
    const implementation = vi.fn(async (data: unknown) => ({
      handledBy: name,
      data,
    }));
    return Object.assign(implementation, {
      __executeImplementation: implementation,
    });
  };
  const resources = {
    getPlayerActivity: resource("getPlayerActivity"),
    getPlayerNotes: resource("getPlayerNotes"),
    getPlayerNote: resource("getPlayerNote"),
    getPlayerExports: resource("getPlayerExports"),
    getPlayerExport: resource("getPlayerExport"),
    getPlayerStats: resource("getPlayerStats"),
    getPlayerStat: resource("getPlayerStat"),
    getBackupStatus: resource("getBackupStatus"),
    getBackupInfo: resource("getBackupInfo"),
    getBackups: resource("getBackups"),
    getBackupHistory: resource("getBackupHistory"),
    getBackupSnapshot: resource("getBackupSnapshot"),
  };
  const resourceActions = {
    upsertPlayerNote: resource("upsertPlayerNote"),
    deletePlayerNote: resource("deletePlayerNote"),
    deletePlayerExport: resource("deletePlayerExport"),
  };

  const serverFunction = (name: string) => {
    const implementation = vi.fn(async (data: unknown) => ({
      handledBy: name,
      data,
    }));
    return Object.assign(implementation, {
      __executeImplementation: implementation,
    });
  };
  const admin = Object.fromEntries(
    [
      "getAppSettings",
      "updateAppSettings",
      "getCorsDiagnostics",
      "reloadCorsDiagnostics",
      "clearCorsBlockedOrigins",
      "testAppRconConnection",
      "getDebugRam",
      "getPerformanceHistory",
      "changePassword",
      "getManagedUsers",
      "createManagedUser",
      "assignManagedUserRole",
      "removeManagedUser",
      "regenerateJwtSecret",
      "getRecoveryCodes",
      "generateRecoveryCodes",
      "getOidcSettings",
      "updateOidcSettings",
      "testOidcConnection",
    ].map((name) => [name, serverFunction(name)]),
  );
  const auth = Object.fromEntries(
    [
      "getAuthStatus",
      "setup",
      "login",
      "refresh",
      "logout",
      "resetStatus",
      "createLocalResetToken",
      "resetPassword",
      "recoverWithCode",
      "getCurrentUser",
      "getRecoveryStatus",
      "getOidcStatus",
    ].map((name) => [name, serverFunction(name)]),
  );
  const mods = Object.fromEntries(
    [
      "getModsStatus",
      "getTrackedMods",
      "trackMod",
      "untrackMod",
      "getIgnoredMods",
      "unignoreMod",
      "clearAllIgnoredMods",
      "getIgnoredModPairs",
      "addIgnoredModPair",
      "removeIgnoredModPair",
      "getServerMods",
      "startModChecker",
      "stopModChecker",
      "setModAutoRestart",
      "setModRestartOptions",
      "getWorkshopStatus",
      "cancelPendingModRestart",
      "getModPresets",
      "updateModPreset",
      "deleteModPreset",
      "addCollectionItem",
      "removeCollectionItem",
      "removeCollectionTracking",
      "saveCollectionCookies",
    ].map((name) => [name, serverFunction(name)]),
  );
  const system = {
    getStorageHealth: serverFunction("getStorageHealth"),
  };
  const fileReads = Object.fromEntries(
    [
      "getServerFilePaths",
      "getServerIni",
      "getServerSandbox",
      "validateServerSandbox",
      "getServerSpawnPoints",
      "getServerSpawnRegions",
      "getServerRawFile",
      "getServerConfigBackups",
      "getConfigTemplates",
      "getConfigTemplate",
      "browseServerFiles",
      "saveServerIni",
      "saveServerSandbox",
      "saveSandboxOption",
      "repairServerSandbox",
      "saveServerSpawnPoints",
      "saveServerSpawnRegions",
      "saveServerRawFile",
      "restoreServerConfigBackup",
      "saveServerAndReload",
      "createServerConfigTemplate",
      "applyServerConfigTemplate",
      "updateServerConfigTemplate",
      "deleteServerConfigTemplate",
    ].map((name) => [name, serverFunction(name)]),
  );
  const legacyServer = Object.fromEntries(
    [
      "checkSteamCmd",
      "configureRcon",
      "configureNetwork",
      "getConsoleLog",
      "getConsoleErrorCount",
      "getConsoleLogStream",
      "clearConsoleLog",
      "getServerUpdate",
      "getServerUpdateStatus",
      "dismissServerAutoUpdateResult",
      "setServerUpdateInterval",
      "getMapVehicles",
    ].map((name) => [name, serverFunction(name)]),
  );
  const bridge = Object.fromEntries(
    ["sendPanelBridgeCommand", "getPanelBridgeCommands"].map((name) => [
      name,
      serverFunction(name),
    ]),
  );
  const bridgeSetup = Object.fromEntries(
    [
      "getPanelBridgeStatus",
      "pingPanelBridge",
      "sendPanelBridgeSetupCommand",
    ].map((name) => [name, serverFunction(name)]),
  );
  const bridgeWorld = Object.fromEntries(
    [
      "sendPanelBridgeWorldCommand",
      "getPanelBridgeServerInfo",
      "savePanelBridgeWorld",
    ].map((name) => [name, serverFunction(name)]),
  );
  const bridgeEffects = {
    sendPanelBridgeEndangerCommand: serverFunction(
      "sendPanelBridgeEndangerCommand",
    ),
    getPanelBridgeCatalog: serverFunction("getPanelBridgeCatalog"),
    scanPanelBridgeCatalog: serverFunction("scanPanelBridgeCatalog"),
  };
  const bridgePlayer = Object.fromEntries(
    [
      "sendPanelBridgePlayerCommand",
      "sendPanelBridgeServerMessage",
      "getPanelBridgeChatInfo",
      "sendPanelBridgeAdminChat",
      "sendPanelBridgeGeneralChat",
      "sendPanelBridgeChatAlert",
    ].map((name) => [name, serverFunction(name)]),
  );
  const bridgeDiagnostics = {
    sendPanelBridgeDiagnosticsCommand: serverFunction(
      "sendPanelBridgeDiagnosticsCommand",
    ),
  };

  return {
    authenticate: vi.fn(),
    getCapabilities: vi.fn(),
    control,
    resources,
    admin,
    auth,
    resourceActions,
    mods,
    system,
    fileReads,
    legacyServer,
    bridge,
    bridgeSetup,
    bridgeWorld,
    bridgeEffects,
    bridgePlayer,
    bridgeDiagnostics,
  };
});

vi.mock("../services/auth.ts", () => ({
  default: { authenticateApiRequest: mocks.authenticate },
}));
vi.mock("../services/permissions.ts", () => ({
  getCapabilitiesForRole: mocks.getCapabilities,
}));
vi.mock("../../panel-client/src/lib/serverGameControl.ts", () => mocks.control);
vi.mock(
  "../../panel-client/src/lib/serverResourceReads.ts",
  () => mocks.resources,
);
vi.mock("../../panel-client/src/lib/serverAdmin.ts", () => mocks.admin);
vi.mock("../../panel-client/src/lib/serverAuth.ts", () => mocks.auth);
vi.mock(
  "../../panel-client/src/lib/serverResourceActions.ts",
  () => mocks.resourceActions,
);
vi.mock("../../panel-client/src/lib/serverMods.ts", () => mocks.mods);
vi.mock("../../panel-client/src/lib/serverSystem.ts", () => mocks.system);
vi.mock("../../panel-client/src/lib/serverFileReads.ts", () => mocks.fileReads);
vi.mock(
  "../../panel-client/src/lib/serverLegacyApi.ts",
  () => mocks.legacyServer,
);
vi.mock("../../panel-client/src/lib/serverPanelBridge.ts", () => mocks.bridge);
vi.mock(
  "../../panel-client/src/lib/serverPanelBridgeSetup.ts",
  () => mocks.bridgeSetup,
);
vi.mock(
  "../../panel-client/src/lib/serverPanelBridgeWorld.ts",
  () => mocks.bridgeWorld,
);
vi.mock(
  "../../panel-client/src/lib/serverPanelBridgeEffects.ts",
  () => mocks.bridgeEffects,
);
vi.mock(
  "../../panel-client/src/lib/serverPanelBridgePlayerChat.ts",
  () => mocks.bridgePlayer,
);
vi.mock(
  "../../panel-client/src/lib/serverPanelBridgeDiagnostics.ts",
  () => mocks.bridgeDiagnostics,
);

const { handleStartApiCompatibilityRequest } =
  await import("../../panel-client/src/lib/startApiCompatibility.ts");

const CONTROL_ROUTES = [
  ["GET", "/api/server/status", "getGameServerStatus"],
  ["GET", "/api/server/network-interfaces", "getNetworkInterfaces"],
  ["GET", "/api/servers", "getManagedServers"],
  ["GET", "/api/servers/active", "getActiveManagedServer"],
  ["GET", "/api/servers/status", "getManagedServersStatus"],
  ["GET", "/api/servers/rcon-status", "getManagedServersRconStatus"],
  ["GET", "/api/servers/active/status", "getActiveComposedStatus"],
  ["GET", "/api/servers/server-1", "getManagedServer"],
  ["GET", "/api/servers/discover-mounts", "getDiscoveredMounts"],
  ["PUT", "/api/servers/server-1", "updateManagedServer"],
  ["DELETE", "/api/servers/server-1", "deleteManagedServer"],
  ["POST", "/api/servers/server-1/activate", "activateManagedServer"],
  [
    "POST",
    "/api/servers/server-1/lifecycle-provider",
    "activateManagedLifecycleProvider",
  ],
  ["GET", "/api/servers/server-1/lifecycle-template", "getLifecycleTemplate"],
  ["POST", "/api/server/start", "startServer"],
  ["POST", "/api/server/stop", "stopServer"],
  ["POST", "/api/server/force-stop", "forceStopServer"],
  ["POST", "/api/server/restart", "restartServer"],
  ["POST", "/api/server/save", "saveGameWorld"],
  ["POST", "/api/server/message", "sendServerMessage"],
  ["POST", "/api/server/weather/start-rain", "startRain"],
  ["POST", "/api/server/weather/stop-rain", "stopRain"],
  ["POST", "/api/server/weather/start-storm", "startStorm"],
  ["POST", "/api/server/weather/stop", "stopWeather"],
  ["POST", "/api/server/events/chopper", "triggerChopper"],
  ["POST", "/api/server/events/gunshot", "triggerGunshot"],
  ["POST", "/api/server/events/lightning", "triggerLightning"],
  ["POST", "/api/server/events/thunder", "triggerThunder"],
  ["POST", "/api/server/events/horde", "createHorde"],
  ["POST", "/api/server/reloadlua", "reloadLua"],
  ["POST", "/api/server/log", "setLogLevel"],
  ["POST", "/api/server/stats", "setServerStats"],
  ["POST", "/api/server/alarm", "alarm"],
  ["POST", "/api/server/removezombies", "removeZombies"],
  ["POST", "/api/server/releasesafehouse", "releaseSafehouse"],
  ["GET", "/api/players", "getPlayers"],
  ["POST", "/api/players/kick", "kickPlayer"],
  ["POST", "/api/players/ban", "banPlayer"],
  ["POST", "/api/players/unban", "unbanPlayer"],
  ["POST", "/api/players/whitelist/add", "addToWhitelist"],
  ["POST", "/api/players/whitelist/remove", "removeFromWhitelist"],
  ["POST", "/api/players/teleport", "teleportPlayer"],
  ["POST", "/api/players/add-item", "addPlayerItem"],
  ["POST", "/api/players/add-xp", "addPlayerXp"],
  ["POST", "/api/players/add-vehicle", "addPlayerVehicle"],
  ["POST", "/api/players/add-vehicle-at", "addPlayerVehicleAt"],
  ["POST", "/api/players/godmode", "setGodMode"],
  ["POST", "/api/players/invisible", "setInvisible"],
  ["POST", "/api/players/noclip", "setNoclip"],
  ["GET", "/api/players/vehicles", "getPlayerVehicles"],
  ["GET", "/api/players/perks", "getPlayerPerks"],
  ["GET", "/api/players/access-levels", "getPlayerAccessLevels"],
  ["POST", "/api/players/access-level", "setAccessLevel"],
  ["GET", "/api/players/steamid-bans", "getSteamIdBans"],
  ["POST", "/api/players/banid", "banSteamId"],
  ["POST", "/api/players/unbanid", "unbanSteamId"],
  ["POST", "/api/players/voiceban", "setVoiceBan"],
  ["POST", "/api/players/adduser", "addRconUser"],
  ["POST", "/api/players/whitelist/addall", "addAllToWhitelist"],
  ["POST", "/api/players/whitelist/steamid/add", "addAllowedSteamId"],
  ["POST", "/api/players/whitelist/steamid/remove", "removeAllowedSteamId"],
  ["GET", "/api/players/whitelist", "getWhitelist"],
];

const RESOURCE_ROUTES = [
  ["GET", "/api/players/activity", "getPlayerActivity"],
  ["GET", "/api/players/notes", "getPlayerNotes"],
  ["GET", "/api/players/notes/Alice", "getPlayerNote"],
  ["POST", "/api/players/notes", "upsertPlayerNote"],
  ["DELETE", "/api/players/notes/Alice", "deletePlayerNote"],
  ["GET", "/api/players/exports", "getPlayerExports"],
  ["GET", "/api/players/exports/Alice/save.json", "getPlayerExport"],
  ["DELETE", "/api/players/exports/Alice/save.json", "deletePlayerExport"],
  ["GET", "/api/players/stats", "getPlayerStats"],
  ["GET", "/api/players/stats/Alice", "getPlayerStat"],
];

const SERVER_FILE_ROUTES = [
  ["GET", "/api/server-files/paths", "getServerFilePaths"],
  ["GET", "/api/server-files/ini", "getServerIni"],
  ["GET", "/api/server-files/sandbox", "getServerSandbox"],
  ["GET", "/api/server-files/sandbox/validate", "validateServerSandbox"],
  ["GET", "/api/server-files/spawnpoints", "getServerSpawnPoints"],
  ["GET", "/api/server-files/spawnregions", "getServerSpawnRegions"],
  ["GET", "/api/server-files/raw/ini", "getServerRawFile"],
  ["GET", "/api/server-files/backups", "getServerConfigBackups"],
  ["GET", "/api/server-files/templates", "getConfigTemplates"],
  ["GET", "/api/server-files/templates/demo", "getConfigTemplate"],
  [
    "GET",
    "/api/server-files/browse-files?path=%2Ftmp&extensions=.png",
    "browseServerFiles",
  ],
];

const SERVER_FILE_WRITE_ROUTES = [
  ["PUT", "/api/server-files/ini", "saveServerIni", { settings: {} }],
  ["PUT", "/api/server-files/sandbox", "saveServerSandbox", { sandbox: {} }],
  [
    "PUT",
    "/api/server-files/sandbox-option",
    "saveSandboxOption",
    { name: "DayLength", value: 1 },
  ],
  ["POST", "/api/server-files/sandbox/repair", "repairServerSandbox", {}],
  ["PUT", "/api/server-files/spawnpoints", "saveServerSpawnPoints", { spawnpoints: {} }],
  ["PUT", "/api/server-files/spawnregions", "saveServerSpawnRegions", { spawnregions: [] }],
  [
    "PUT",
    "/api/server-files/raw/ini",
    "saveServerRawFile",
    { content: "Key=Value" },
  ],
  [
    "POST",
    "/api/server-files/restore/demo.ini.2026.bak",
    "restoreServerConfigBackup",
    {},
  ],
  ["POST", "/api/server-files/save-and-reload", "saveServerAndReload", {}],
  [
    "POST",
    "/api/server-files/templates",
    "createServerConfigTemplate",
    { name: "Demo" },
  ],
  [
    "POST",
    "/api/server-files/templates/demo/apply",
    "applyServerConfigTemplate",
    { applyIni: true },
  ],
  [
    "PUT",
    "/api/server-files/templates/demo",
    "updateServerConfigTemplate",
    { name: "Updated" },
  ],
  [
    "DELETE",
    "/api/server-files/templates/demo",
    "deleteServerConfigTemplate",
    {},
  ],
];

const LEGACY_SERVER_ROUTES = [
  [
    "GET",
    "/api/server/steamcmd/check?path=%2Ftmp",
    "checkSteamCmd",
    undefined,
    { path: "/tmp" },
  ],
  [
    "POST",
    "/api/server/configure-rcon",
    "configureRcon",
    { rconPassword: "secret" },
    { rconPassword: "secret" },
  ],
  [
    "POST",
    "/api/server/configure-network",
    "configureNetwork",
    { serverPort: 16261, useUpnp: false },
    { serverPort: 16261, useUpnp: false },
  ],
  [
    "GET",
    "/api/server/console-log?lines=25&filter=all",
    "getConsoleLog",
    undefined,
    { lines: "25", filter: "all" },
  ],
  [
    "GET",
    "/api/server/console-log/error-count",
    "getConsoleErrorCount",
    undefined,
    {},
  ],
  [
    "GET",
    "/api/server/console-log/stream?lastSize=10&filter=important",
    "getConsoleLogStream",
    undefined,
    { lastSize: "10", filter: "important" },
  ],
  [
    "POST",
    "/api/server/console-log/clear",
    "clearConsoleLog",
    {},
    {},
  ],
  [
    "GET",
    "/api/server/update-check?force=true",
    "getServerUpdate",
    undefined,
    { force: "true" },
  ],
  [
    "GET",
    "/api/server/update-check/status",
    "getServerUpdateStatus",
    undefined,
    {},
  ],
  [
    "POST",
    "/api/server/update-check/auto-update-result/dismiss",
    "dismissServerAutoUpdateResult",
    {},
    {},
  ],
  [
    "POST",
    "/api/server/update-check/interval",
    "setServerUpdateInterval",
    { minutes: 30 },
    { minutes: 30 },
  ],
  ["GET", "/api/map/vehicles", "getMapVehicles", undefined, {}],
];

const PUBLIC_AUTH_ROUTES = [
  ["POST", "/api/auth/setup", "setup", { setupToken: "setup-token" }, 201],
  [
    "POST",
    "/api/auth/login",
    "login",
    { username: "Alice", password: "pw" },
    200,
  ],
  ["POST", "/api/auth/refresh", "refresh", undefined, 200],
  ["POST", "/api/auth/logout", "logout", undefined, 200],
  ["GET", "/api/auth/reset-status", "resetStatus", undefined, 200],
  [
    "POST",
    "/api/auth/reset-token/local",
    "createLocalResetToken",
    undefined,
    200,
  ],
  [
    "POST",
    "/api/auth/reset-password",
    "resetPassword",
    { token: "token", newPassword: "password" },
    200,
  ],
  [
    "POST",
    "/api/auth/recover-with-code",
    "recoverWithCode",
    { code: "code", newPassword: "password" },
    200,
  ],
];

const CREATED_ROUTES = [
  ["POST", "/api/servers/create-from-discovery", "createServerFromDiscovery"],
  ["POST", "/api/servers", "createManagedServer"],
];

const PANEL_BRIDGE_ROUTES = [
  ["GET", "/api/panel-bridge/status", "getPanelBridgeStatus"],
  ["POST", "/api/panel-bridge/auto-configure", "sendPanelBridgeSetupCommand"],
  ["GET", "/api/panel-bridge/scan-server/server-1", "sendPanelBridgeSetupCommand"],
  ["POST", "/api/panel-bridge/auto-detect", "sendPanelBridgeSetupCommand"],
  ["POST", "/api/panel-bridge/configure", "sendPanelBridgeSetupCommand"],
  ["POST", "/api/panel-bridge/configure-direct", "sendPanelBridgeSetupCommand"],
  ["POST", "/api/panel-bridge/sftp/test", "sendPanelBridgeSetupCommand"],
  ["POST", "/api/panel-bridge/sftp/configure", "sendPanelBridgeSetupCommand"],
  ["POST", "/api/panel-bridge/sftp/logs/list", "sendPanelBridgeSetupCommand"],
  ["POST", "/api/panel-bridge/sftp/logs/tail", "sendPanelBridgeSetupCommand"],
  ["POST", "/api/panel-bridge/sftp/config/list", "sendPanelBridgeSetupCommand"],
  ["POST", "/api/panel-bridge/start", "sendPanelBridgeSetupCommand"],
  ["POST", "/api/panel-bridge/stop", "sendPanelBridgeSetupCommand"],
  ["GET", "/api/panel-bridge/scan-paths", "sendPanelBridgeSetupCommand"],
  ["POST", "/api/panel-bridge/refresh", "sendPanelBridgeSetupCommand"],
  ["GET", "/api/panel-bridge/ping", "pingPanelBridge"],
  ["POST", "/api/panel-bridge/command", "sendPanelBridgeCommand"],
  ["GET", "/api/panel-bridge/weather", "sendPanelBridgeWorldCommand"],
  ["GET", "/api/panel-bridge/server-info", "getPanelBridgeServerInfo"],
  ["POST", "/api/panel-bridge/weather/blizzard", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/weather/tropical-storm", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/weather/storm", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/weather/stop", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/weather/generate", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/weather/snow", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/weather/rain/start", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/weather/rain/stop", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/weather/lightning", "sendPanelBridgeWorldCommand"],
  ["GET", "/api/panel-bridge/climate/floats", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/climate/float", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/climate/reset", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/climate/temperature", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/climate/wind", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/climate/fog", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/climate/clouds", "sendPanelBridgeWorldCommand"],
  ["GET", "/api/panel-bridge/time", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/time", "sendPanelBridgeWorldCommand"],
  ["GET", "/api/panel-bridge/world/stats", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/world/save", "savePanelBridgeWorld"],
  ["GET", "/api/panel-bridge/players", "sendPanelBridgePlayerCommand"],
  ["GET", "/api/panel-bridge/players/Alice", "sendPanelBridgePlayerCommand"],
  ["POST", "/api/panel-bridge/players/Alice/teleport", "sendPanelBridgePlayerCommand"],
  ["POST", "/api/panel-bridge/message", "sendPanelBridgeServerMessage"],
  ["GET", "/api/panel-bridge/sandbox", "sendPanelBridgeWorldCommand"],
  ["GET", "/api/panel-bridge/commands", "getPanelBridgeCommands"],
  ["GET", "/api/panel-bridge/mod-path", "sendPanelBridgeSetupCommand"],
  ["POST", "/api/panel-bridge/install-local", "sendPanelBridgeSetupCommand"],
  ["POST", "/api/panel-bridge/install-mod-auto", "sendPanelBridgeSetupCommand"],
  ["POST", "/api/panel-bridge/install-mod", "sendPanelBridgeSetupCommand"],
  ["POST", "/api/panel-bridge/sound/world", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/sound/near-player", "sendPanelBridgeEndangerCommand"],
  ["POST", "/api/panel-bridge/sound/gunshot", "sendPanelBridgeEndangerCommand"],
  ["POST", "/api/panel-bridge/sound/alarm", "sendPanelBridgeEndangerCommand"],
  ["POST", "/api/panel-bridge/sound/noise", "sendPanelBridgeEndangerCommand"],
  ["GET", "/api/panel-bridge/utilities/status", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/utilities/restore", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/utilities/shutoff", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/character/export", "sendPanelBridgePlayerCommand"],
  ["POST", "/api/panel-bridge/character/import", "sendPanelBridgePlayerCommand"],
  ["POST", "/api/panel-bridge/players/Alice/give-item", "sendPanelBridgePlayerCommand"],
  ["POST", "/api/panel-bridge/players/Alice/heal", "sendPanelBridgePlayerCommand"],
  ["POST", "/api/panel-bridge/players/Alice/kill", "sendPanelBridgePlayerCommand"],
  ["POST", "/api/panel-bridge/players/Alice/godmode", "sendPanelBridgePlayerCommand"],
  ["POST", "/api/panel-bridge/players/Alice/invisible", "sendPanelBridgePlayerCommand"],
  ["GET", "/api/panel-bridge/zombies/count", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/zombies/clear-near-player", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/zombies/clear-all", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/zombies/spawn-near", "sendPanelBridgeEndangerCommand"],
  ["POST", "/api/panel-bridge/zombies/spawn-behind", "sendPanelBridgeEndangerCommand"],
  ["POST", "/api/panel-bridge/visual/view-distance", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/visual/daylight", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/visual/night-strength", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/visual/desaturation", "sendPanelBridgeWorldCommand"],
  ["POST", "/api/panel-bridge/visual/ambient", "sendPanelBridgeWorldCommand"],
  ["GET", "/api/panel-bridge/chat/info", "getPanelBridgeChatInfo"],
  ["POST", "/api/panel-bridge/chat/admin", "sendPanelBridgeAdminChat"],
  ["POST", "/api/panel-bridge/chat/general", "sendPanelBridgeGeneralChat"],
  ["POST", "/api/panel-bridge/chat/alert", "sendPanelBridgeChatAlert"],
  ["GET", "/api/panel-bridge/debug/log", "sendPanelBridgeDiagnosticsCommand"],
  ["GET", "/api/panel-bridge/debug/stats", "sendPanelBridgeDiagnosticsCommand"],
  ["POST", "/api/panel-bridge/debug/mode", "sendPanelBridgeDiagnosticsCommand"],
  ["GET", "/api/panel-bridge/debug/api", "sendPanelBridgeDiagnosticsCommand"],
  ["GET", "/api/panel-bridge/debug/handlers", "sendPanelBridgeDiagnosticsCommand"],
  ["POST", "/api/panel-bridge/debug/clear-errors", "sendPanelBridgeDiagnosticsCommand"],
  ["GET", "/api/panel-bridge/catalog/items", "getPanelBridgeCatalog"],
  ["GET", "/api/panel-bridge/catalog/vehicles", "getPanelBridgeCatalog"],
  ["POST", "/api/panel-bridge/catalog/scan-items", "scanPanelBridgeCatalog"],
  ["POST", "/api/panel-bridge/catalog/scan-vehicles", "scanPanelBridgeCatalog"],
  ["POST", "/api/panel-bridge/catalog/debug-item-script", "sendPanelBridgeDiagnosticsCommand"],
];

beforeEach(() => {
  mocks.authenticate.mockReset().mockResolvedValue({
    ok: true,
    user: {
      userId: "user-1",
      username: "admin",
      role: "admin",
      tokenGen: 0,
    },
  });
  mocks.getCapabilities
    .mockReset()
    .mockResolvedValue([
      "server.control",
      "server.world_events",
      "server.configure",
      "server.install",
      "servers.manage",
      "servers.discover",
      "panel.settings",
      "diagnostics.manage",
      "mods.manage",
      "serverfiles.manage",
      "players.view",
      "players.moderate",
      "players.gm_tools",
    "players.endanger_or_impersonate",
    "bridge.setup",
    "bridge.diagnostics",
  ]);
  for (const fn of [
    ...Object.values(mocks.control),
    ...Object.values(mocks.resources),
    ...Object.values(mocks.resourceActions),
    ...Object.values(mocks.admin),
    ...Object.values(mocks.auth),
    ...Object.values(mocks.mods),
    ...Object.values(mocks.system),
    ...Object.values(mocks.fileReads),
    ...Object.values(mocks.legacyServer),
    ...Object.values(mocks.bridge),
    ...Object.values(mocks.bridgeSetup),
    ...Object.values(mocks.bridgeWorld),
    ...Object.values(mocks.bridgeEffects),
    ...Object.values(mocks.bridgePlayer),
    ...Object.values(mocks.bridgeDiagnostics),
  ]) {
    fn.mockClear();
  }
});

function makeRequest(method: string, path: string, body?: unknown): Request {
  const headers = new Headers({ authorization: "Bearer test-token" });
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`http://panel.test${path}`, init);
}

async function responseBody(response: Response): Promise<unknown> {
  return response.json();
}

describe("Start compatibility server and player routes", () => {
  it.each(CONTROL_ROUTES)(
    "dispatches %s %s to %s",
    async (method, path, functionName) => {
      const response = await handleStartApiCompatibilityRequest(
        makeRequest(method, path),
      );
      const expectedData =
        method === "PUT"
          ? { id: "server-1", updates: {} }
          : path.includes("/server-1")
            ? { id: "server-1" }
            : {};

      expect(response.status).toBe(200);
      expect(await responseBody(response)).toEqual({
        handledBy: functionName,
        data: expectedData,
      });
      expect(mocks.control[functionName]).toHaveBeenCalledWith(
        expectedData,
        expect.objectContaining({ authenticatedUser: expect.any(Object) }),
      );
    },
  );

  it.each(RESOURCE_ROUTES)(
    "dispatches %s %s to %s",
    async (method, path, functionName) => {
      const response = await handleStartApiCompatibilityRequest(
        makeRequest(method, path),
      );

      expect(response.status).toBe(200);
      expect(await responseBody(response)).toEqual({
        handledBy: functionName,
        data: path.endsWith("Alice")
          ? { playerName: "Alice" }
          : path.includes("/exports/")
            ? { username: "Alice", filename: "save.json" }
            : {},
      });
    },
  );

  it.each(SERVER_FILE_ROUTES)(
    "dispatches %s %s to %s",
    async (method, path, functionName) => {
      const response = await handleStartApiCompatibilityRequest(
        makeRequest(method, path),
      );

      expect(response.status).toBe(200);
      const expectedData = path.includes("raw/ini")
        ? { type: "ini" }
        : path.includes("templates/demo")
          ? { id: "demo" }
          : path.includes("browse-files")
            ? { path: "/tmp", extensions: ".png" }
            : {};
      expect(await responseBody(response)).toEqual({
        handledBy: functionName,
        data: expectedData,
      });
    },
  );

  it.each(SERVER_FILE_WRITE_ROUTES)(
    "dispatches %s %s to %s",
    async (method, path, functionName, body) => {
      const response = await handleStartApiCompatibilityRequest(
        makeRequest(method, path, body),
      );

      expect(response.status).toBe(200);
      const params = path.includes("/restore/")
        ? { filename: "demo.ini.2026.bak" }
        : path.includes("/raw/")
          ? { ...body, type: "ini" }
        : path.includes("/templates/")
          ? { id: "demo", ...body }
          : body;
      expect(await responseBody(response)).toEqual({
        handledBy: functionName,
        data: params,
      });
      expect(mocks.fileReads[functionName]).toHaveBeenCalledWith(
        params,
        expect.objectContaining({ authenticatedUser: expect.any(Object) }),
      );
    },
  );

  it.each(LEGACY_SERVER_ROUTES)(
    "dispatches legacy JSON %s %s to %s",
    async (method, path, functionName, body, expectedData) => {
      const response = await handleStartApiCompatibilityRequest(
        makeRequest(method, path, body),
      );

      expect(response.status).toBe(200);
      expect(await responseBody(response)).toEqual({
        handledBy: functionName,
        data: expectedData,
      });
      expect(mocks.legacyServer[functionName]).toHaveBeenCalledWith(
        expectedData,
        expect.objectContaining({ authenticatedUser: expect.any(Object) }),
      );
    },
  );

  it.each(CREATED_ROUTES)(
    "returns 201 for %s %s through %s",
    async (method, path, functionName) => {
      const response = await handleStartApiCompatibilityRequest(
        makeRequest(method, path, {}),
      );

      expect(response.status).toBe(201);
      expect(await responseBody(response)).toEqual({
        handledBy: functionName,
        data: {},
      });
    },
  );

  it.each(PANEL_BRIDGE_ROUTES)(
    "dispatches PanelBridge %s %s to %s",
    async (method, path, functionName) => {
      const response = await handleStartApiCompatibilityRequest(
        makeRequest(method, path),
      );

      expect(response.status).toBe(200);
      expect(await responseBody(response)).toEqual({
        handledBy: functionName,
        data: expect.anything(),
      });
    },
  );

  it("keeps PanelBridge command and action payloads separate", async () => {
    const command = await handleStartApiCompatibilityRequest(
      makeRequest("POST", "/api/panel-bridge/command", {
        action: "getStats",
        args: { limit: 10 },
      }),
    );
    expect(await responseBody(command)).toEqual({
      handledBy: "sendPanelBridgeCommand",
      data: { action: "getStats", args: { limit: 10 } },
    });

    const world = await handleStartApiCompatibilityRequest(
      makeRequest("POST", "/api/panel-bridge/weather/storm", {
        duration: 2,
      }),
    );
    expect(await responseBody(world)).toEqual({
      handledBy: "sendPanelBridgeWorldCommand",
      data: { action: "triggerStorm", args: { duration: 2 } },
    });
  });

  it("keeps the legacy PanelBridge ping and command catalog outside the capability matrix", async () => {
    mocks.getCapabilities.mockResolvedValue([]);

    const ping = await handleStartApiCompatibilityRequest(
      makeRequest("GET", "/api/panel-bridge/ping"),
    );
    const commands = await handleStartApiCompatibilityRequest(
      makeRequest("GET", "/api/panel-bridge/commands"),
    );

    expect(ping.status).toBe(200);
    expect(commands.status).toBe(200);
    expect(mocks.authenticate).toHaveBeenCalledTimes(2);
    expect(mocks.getCapabilities).not.toHaveBeenCalled();
  });

  it("preserves query and JSON body data for legacy callers", async () => {
    const activity = await handleStartApiCompatibilityRequest(
      makeRequest("GET", "/api/players/activity?player=Alice&limit=25"),
    );
    expect(await responseBody(activity)).toEqual({
      handledBy: "getPlayerActivity",
      data: { player: "Alice", limit: "25" },
    });

    const restart = await handleStartApiCompatibilityRequest(
      makeRequest("POST", "/api/server/restart", { reason: "maintenance" }),
    );
    expect(await responseBody(restart)).toEqual({
      handledBy: "restartServer",
      data: { reason: "maintenance" },
    });

    const update = await handleStartApiCompatibilityRequest(
      makeRequest("PUT", "/api/servers/server-1", { name: "Renamed" }),
    );
    expect(await responseBody(update)).toEqual({
      handledBy: "updateManagedServer",
      data: { id: "server-1", updates: { name: "Renamed" } },
    });

    const lifecycleTemplate = await handleStartApiCompatibilityRequest(
      makeRequest(
        "GET",
        "/api/servers/server-1/lifecycle-template?provider=systemd&serviceUser=pz",
      ),
    );
    expect(await responseBody(lifecycleTemplate)).toEqual({
      handledBy: "getLifecycleTemplate",
      data: { id: "server-1", provider: "systemd", serviceUser: "pz" },
    });
  });

  it("enforces the route capability before invoking the implementation", async () => {
    mocks.getCapabilities.mockResolvedValue([]);

    const response = await handleStartApiCompatibilityRequest(
      makeRequest("POST", "/api/players/kick", { username: "Alice" }),
    );

    expect(response.status).toBe(403);
    expect(await responseBody(response)).toEqual({
      error: "Insufficient permissions",
      code: "PERMISSION_DENIED",
    });
    expect(mocks.control.kickPlayer).not.toHaveBeenCalled();
  });

  it("keeps public status endpoints public", async () => {
    mocks.authenticate.mockRejectedValue(new Error("must not authenticate"));

    const response = await handleStartApiCompatibilityRequest(
      new Request("http://panel.test/api/auth/status"),
    );

    expect(response.status).toBe(200);
    expect(await responseBody(response)).toEqual({
      handledBy: "getAuthStatus",
      data: {},
    });
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it.each(PUBLIC_AUTH_ROUTES)(
    "dispatches public auth route %s %s to %s",
    async (method, path, functionName, body, expectedStatus) => {
      mocks.authenticate.mockRejectedValue(new Error("must not authenticate"));

      const response = await handleStartApiCompatibilityRequest(
        makeRequest(method, path, body),
      );

      expect(response.status).toBe(expectedStatus);
      expect(await responseBody(response)).toEqual({
        handledBy: functionName,
        data: body || {},
      });
      expect(mocks.auth[functionName]).toHaveBeenCalledWith(
        body || {},
        expect.objectContaining({ authenticatedUser: null }),
      );
      expect(mocks.authenticate).not.toHaveBeenCalled();
    },
  );

  it("accepts any permitted backup capability", async () => {
    mocks.getCapabilities.mockResolvedValue(["backups.download"]);

    const response = await handleStartApiCompatibilityRequest(
      makeRequest("GET", "/api/backup/history?limit=25&serverId=server-1"),
    );

    expect(response.status).toBe(200);
    expect(await responseBody(response)).toEqual({
      handledBy: "getBackupHistory",
      data: { limit: "25", serverId: "server-1" },
    });
    expect(mocks.resources.getBackupHistory).toHaveBeenCalledWith(
      { limit: "25", serverId: "server-1" },
      expect.objectContaining({ authenticatedUser: expect.any(Object) }),
    );
  });

  it("preserves legacy query-token authentication", async () => {
    const response = await handleStartApiCompatibilityRequest(
      new Request("http://panel.test/api/auth/me?token=query-token"),
    );

    expect(response.status).toBe(200);
    expect(mocks.authenticate).toHaveBeenCalledWith("Bearer query-token");
  });

  it.each([
    ["POST", "/api/auth/regenerate-jwt-secret", "regenerateJwtSecret"],
    ["GET", "/api/auth/recovery-codes", "getRecoveryCodes"],
    ["POST", "/api/auth/recovery-codes", "generateRecoveryCodes"],
  ])("keeps %s %s admin-only", async (method, path, functionName) => {
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: {
        userId: "user-1",
        username: "operator",
        role: "operator",
        tokenGen: 0,
      },
    });

    const response = await handleStartApiCompatibilityRequest(
      makeRequest(method, path),
    );

    expect(response.status).toBe(403);
    expect(await responseBody(response)).toEqual({
      error: "Insufficient permissions",
      code: "PERMISSION_DENIED",
    });
    expect(mocks.admin[functionName]).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/api/system/storage-health", "system", "getStorageHealth"],
    ["PUT", "/api/config/app-settings", "admin", "updateAppSettings"],
    ["GET", "/api/mods/status", "mods", "getModsStatus"],
    ["DELETE", "/api/mods/track/123", "mods", "untrackMod"],
    ["GET", "/api/auth/me", "auth", "getCurrentUser"],
    [
      "GET",
      "/api/debug/performance-history?limit=12",
      "admin",
      "getPerformanceHistory",
    ],
  ])(
    "dispatches the migrated %s %s endpoint to %s.%s",
    async (method, path, source, functionName) => {
      const response = await handleStartApiCompatibilityRequest(
        makeRequest(
          method,
          path,
          method === "PUT" ? { settings: { darkMode: true } } : undefined,
        ),
      );

      expect(response.status).toBe(200);
      expect(await responseBody(response)).toEqual({
        handledBy: functionName,
        data:
          path === "/api/config/app-settings"
            ? { settings: { darkMode: true } }
            : path === "/api/mods/track/123"
              ? { workshopId: "123" }
              : path.includes("performance-history")
                ? { limit: 12 }
                : {},
      });
      expect(
        (mocks[source] as Record<string, ReturnType<typeof vi.fn>>)[
          functionName
        ],
      ).toHaveBeenCalled();
    },
  );

  it("keeps the legacy performance-history default and clamp", async () => {
    const response = await handleStartApiCompatibilityRequest(
      makeRequest("GET", "/api/debug/performance-history?limit=9999"),
    );

    expect(response.status).toBe(200);
    expect(await responseBody(response)).toEqual({
      handledBy: "getPerformanceHistory",
      data: { limit: 1440 },
    });

    const defaultResponse = await handleStartApiCompatibilityRequest(
      makeRequest("GET", "/api/debug/performance-history"),
    );
    expect(await responseBody(defaultResponse)).toEqual({
      handledBy: "getPerformanceHistory",
      data: { limit: 60 },
    });
  });
});
