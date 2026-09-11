export const PANEL_BRIDGE_COMMANDS = [
      { action: "ping", description: "Health check", args: {} },
      {
        action: "getServerInfo",
        description: "Get server info and player list",
        args: {},
      },
      { action: "saveWorld", description: "Trigger world save", args: {} },

      {
        action: "getWeather",
        description: "Get current weather data",
        args: {},
      },
      {
        action: "triggerBlizzard",
        description: "Trigger a blizzard",
        args: { duration: "number (hours, default: 2.0)" },
      },
      {
        action: "triggerTropicalStorm",
        description: "Trigger tropical storm",
        args: { duration: "number (hours, default: 2.0)" },
      },
      {
        action: "triggerStorm",
        description: "Trigger a storm",
        args: { duration: "number (hours, default: 2.0)" },
      },
      { action: "stopWeather", description: "Stop all weather", args: {} },
      {
        action: "generateWeather",
        description: "Generate weather period",
        args: {
          strength: "number 0-1 (default: 0.5)",
          frontType: "number 0=stationary, 1=cold, 2=warm (default: 0)",
        },
      },
      {
        action: "setSnow",
        description: "Enable/disable snow (auto-enables rain)",
        args: {
          enabled: "boolean (default: true)",
          intensity: "number 0-1 (optional, for rain start)",
        },
      },
      {
        action: "startRain",
        description: "Start rain",
        args: { intensity: "number 0-1 (default: 0.5)" },
      },
      { action: "stopRain", description: "Stop rain", args: {} },
      {
        action: "triggerLightning",
        description: "Trigger lightning bolt",
        args: {
          x: "number (optional)",
          y: "number (optional)",
          strike: "boolean (default: true)",
          light: "boolean (default: true)",
          rumble: "boolean (default: true)",
        },
      },

      {
        action: "getClimateFloats",
        description: "Get all climate float values (IDs 0-12)",
        args: {},
      },
      {
        action: "setClimateFloat",
        description: "Set climate float by ID",
        args: {
          floatId: "number 0-12 (required)",
          value: "number (required)",
          enable: "boolean (default: true)",
        },
      },
      {
        action: "resetClimateOverrides",
        description: "Reset all admin climate overrides",
        args: {},
      },
      {
        action: "setTemperature",
        description: "Set temperature (Celsius)",
        args: { value: "number -50 to +50 (default: 22)" },
      },
      {
        action: "setWind",
        description: "Set wind intensity",
        args: { value: "number 0-1 (default: 0.5)" },
      },
      {
        action: "setFog",
        description: "Set fog intensity",
        args: { value: "number 0-1 (default: 0)" },
      },
      {
        action: "setClouds",
        description: "Set cloud intensity",
        args: { value: "number 0-1 (default: 0)" },
      },

      {
        action: "setDayLight",
        description: "Set daylight strength",
        args: { value: "number 0-1 (default: 1.0)" },
      },
      {
        action: "setNightStrength",
        description: "Set night strength",
        args: { value: "number 0-1 (default: 0)" },
      },
      {
        action: "setDesaturation",
        description: "Set desaturation level",
        args: { value: "number 0-1 (default: 0)" },
      },
      {
        action: "setViewDistance",
        description: "Set view distance",
        args: { value: "number 0-1 (default: 1.0)" },
      },
      {
        action: "setAmbient",
        description: "Set ambient light",
        args: { value: "number 0-1 (default: 1.0)" },
      },

      {
        action: "getGameTime",
        description: "Get current game time/date",
        args: {},
      },
      {
        action: "setGameTime",
        description: "Set game time/date (only sent fields are changed)",
        args: {
          hour: "number (optional)",
          day: "number (optional)",
          month: "number 1-12 (optional)",
          year: "number (optional)",
        },
      },

      {
        action: "getWorldStats",
        description: "Get world statistics",
        args: {},
      },
      {
        action: "getSandboxOptions",
        description: "Get sandbox options (read-only)",
        args: {},
      },

      {
        action: "getAllPlayerDetails",
        description: "Get detailed info for all online players",
        args: {},
      },
      {
        action: "getPlayerDetails",
        description: "Get detailed info for a player",
        args: { username: "string (required)" },
      },
      {
        action: "teleportPlayer",
        description: "Teleport a player",
        args: {
          username: "string (required)",
          x: "number (required)",
          y: "number (required)",
          z: "number (default: 0)",
        },
      },
      {
        action: "healPlayer",
        description: "Fully heal a player",
        args: { username: "string (required)" },
      },
      {
        action: "killPlayer",
        description: "Kill a player",
        args: { username: "string (required)" },
      },
      {
        action: "setGodMode",
        description: "Toggle god mode",
        args: {
          username: "string (required)",
          enabled: "boolean (default: false)",
        },
      },
      {
        action: "setInvisible",
        description: "Toggle invisibility",
        args: {
          username: "string (required)",
          enabled: "boolean (default: false)",
        },
      },
      {
        action: "giveItem",
        description: "Give item to player",
        args: {
          username: "string (required)",
          itemType: 'string e.g. "Base.Axe" (required)',
          count: "number 1-100 (default: 1)",
        },
      },

      {
        action: "exportPlayerData",
        description: "Export full character data (perks, inventory, traits)",
        args: { username: "string (required)" },
      },
      {
        action: "importPlayerData",
        description: "Import/restore character data",
        args: {
          username: "string (required)",
          data: "object (required, from export)",
          options:
            "{ restorePerks: boolean, restoreInventory: boolean } (optional, both default true)",
        },
      },

      {
        action: "sendToServerChat",
        description:
          "Send message to server chat (isAlert=true for system announcement)",
        args: {
          message: "string (required)",
          isAlert: "boolean (default: false)",
        },
      },
      {
        action: "sendToAdminChat",
        description: "Send message to admin-only chat",
        args: { message: "string (required)" },
      },
      {
        action: "sendToGeneralChat",
        description: "Send message to general chat with custom author",
        args: {
          message: "string (required)",
          author: 'string (default: "[Panel]")',
        },
      },
      {
        action: "getChatInfo",
        description: "Get available chat types",
        args: {},
      },

      {
        action: "playWorldSound",
        description: "Create zombie-attracting sound at coordinates",
        args: {
          x: "number (required)",
          y: "number (required)",
          z: "number (default: 0)",
          radius: "number (default: 50)",
          volume: "number (default: 100)",
        },
      },
      {
        action: "playSoundNearPlayer",
        description: "Create sound at player location",
        args: {
          username: "string (required)",
          radius: "number (default: 50)",
          volume: "number (default: 100)",
        },
      },
      {
        action: "triggerGunshot",
        description: "Simulate gunshot (150m radius)",
        args: {
          x: "number",
          y: "number",
          username: "string (alternative to x/y)",
        },
      },
      {
        action: "triggerAlarmSound",
        description: "Trigger alarm sound (80m radius)",
        args: {
          x: "number",
          y: "number",
          username: "string (alternative to x/y)",
        },
      },
      {
        action: "createNoise",
        description: "Create custom noise",
        args: {
          x: "number",
          y: "number",
          radius: "number 10-500 (default: 100)",
          volume: "number 1-500 (default: 100)",
          username: "string (alternative to x/y)",
        },
      },

      {
        action: "getUtilitiesStatus",
        description: "Get power/water status",
        args: {},
      },
      {
        action: "restoreUtilities",
        description: "Restore power and/or water",
        args: {
          power: "boolean (default: true)",
          water: "boolean (default: true)",
        },
      },
      {
        action: "shutOffUtilities",
        description: "Shut off power and/or water",
        args: {
          power: "boolean (default: true)",
          water: "boolean (default: true)",
        },
      },

      {
        action: "getZombieCount",
        description: "Get zombie count in loaded cells",
        args: {},
      },
      {
        action: "clearZombiesNearPlayer",
        description: "Remove zombies near a player",
        args: { username: "string (required)", radius: "number (default: 50)" },
      },
      {
        action: "clearAllZombies",
        description: "Remove ALL zombies from loaded cells",
        args: {},
      },
      {
        action: "spawnHordeNearPlayer",
        description: "Spawn horde 50-70 tiles from player",
        args: {
          username: "string (required)",
          count: "number 1-500 (default: 50)",
        },
      },
      {
        action: "spawnHordeBehindPlayer",
        description: "Spawn horde behind player based on facing direction",
        args: {
          username: "string (required)",
          count: "number 1-500 (default: 50)",
        },
      },

      {
        action: "getSafehouses",
        description: "List all safehouses and key metadata",
        args: {},
      },
      {
        action: "safehouseAddPlayer",
        description: "Add player to safehouse members",
        args: {
          safehouseRef: "string id/title (required)",
          username: "string (required)",
        },
      },
      {
        action: "safehouseRemovePlayer",
        description: "Remove player from safehouse members",
        args: {
          safehouseRef: "string id/title (required)",
          username: "string (required)",
        },
      },
      {
        action: "safehouseSetOwner",
        description: "Transfer safehouse ownership",
        args: {
          safehouseRef: "string id/title (required)",
          owner: "string (required)",
        },
      },
      {
        action: "safehouseSetRespawn",
        description: "Enable/disable respawn in safehouse for user",
        args: {
          safehouseRef: "string id/title (required)",
          username: "string (required)",
          enabled: "boolean (required)",
        },
      },

      {
        action: "getFactions",
        description: "List all factions with members",
        args: {},
      },
      {
        action: "createFaction",
        description: "Create a faction",
        args: { name: "string (required)", owner: "string (required)" },
      },
      {
        action: "factionAddPlayer",
        description: "Add player to faction",
        args: {
          factionName: "string (required)",
          username: "string (required)",
        },
      },
      {
        action: "factionRemovePlayer",
        description: "Remove player from faction",
        args: {
          factionName: "string (required)",
          username: "string (required)",
        },
      },
      {
        action: "factionSetTag",
        description: "Set faction tag",
        args: {
          factionName: "string (required)",
          tag: "string (required, max 8)",
        },
      },
      {
        action: "removeFaction",
        description: "Remove faction entirely",
        args: { factionName: "string (required)" },
      },

      {
        action: "getVehiclesDetailed",
        description: "List loaded vehicles with telemetry",
        args: {},
      },
      {
        action: "vehicleRepair",
        description: "Repair a vehicle",
        args: { vehicleId: "number (required)" },
      },
      {
        action: "vehicleSetAlarm",
        description: "Toggle vehicle alarm and optionally trigger",
        args: { vehicleId: "number (required)", enabled: "boolean (required)" },
      },
      {
        action: "vehicleSetSiren",
        description: "Set vehicle siren mode",
        args: {
          vehicleId: "number (required)",
          mode: "number (optional)",
          enabled: "boolean (optional fallback)",
        },
      },
      {
        action: "vehicleSetTrunkLocked",
        description: "Lock/unlock vehicle trunk",
        args: { vehicleId: "number (required)", locked: "boolean (required)" },
      },

      {
        action: "triggerSwarmEvent",
        description: "Spawn a zombie swarm in rectangular area",
        args: {
          count: "number 1-500 (default: 25)",
          x1: "number (required)",
          y1: "number (required)",
          x2: "number (required)",
          y2: "number (required)",
        },
      },
      {
        action: "runEventSequence",
        description:
          "Execute chained operation steps (chat/weather/swarm/utilities/noise)",
        args: {
          steps: "array (required)",
          maxSteps: "number 1-50 (optional default: 20)",
        },
      },

      {
        action: "getInfrastructureSnapshot",
        description:
          "Get hydro/weather/temperature and optional sampled point data",
        args: {
          x: "number (optional)",
          y: "number (optional)",
          z: "number (optional default: 0)",
        },
      },

      {
        action: "moderationKickUser",
        description: "Kick a user through BanSystem",
        args: {
          username: "string (required)",
          reason: "string (optional)",
          description: "string (optional)",
        },
      },
      {
        action: "moderationBanUser",
        description: "Ban/unban user through BanSystem",
        args: {
          username: "string (required)",
          reason: "string (optional)",
          ban: "boolean (default: true)",
        },
      },
      {
        action: "moderationBanIP",
        description: "Ban/unban IP through BanSystem",
        args: {
          ip: "string (required)",
          reason: "string (optional)",
          ban: "boolean (default: true)",
        },
      },
      {
        action: "moderationBanSteamID",
        description: "Ban/unban SteamID through BanSystem",
        args: {
          steamId: "string (required)",
          reason: "string (optional)",
          ban: "boolean (default: true)",
        },
      },

      {
        action: "getDebugLog",
        description: "Get mod debug log entries",
        args: {
          limit: "number (default: 50)",
          minLevel: "string: DEBUG|INFO|WARN|ERROR (default: DEBUG)",
        },
      },
      { action: "getStats", description: "Get mod statistics", args: {} },
      {
        action: "setDebugMode",
        description: "Toggle verbose logging",
        args: { enabled: "boolean (required)" },
      },
      {
        action: "checkAPI",
        description: "Check API method availability",
        args: {
          object: "string (default: ClimateManager)",
          method: "string (optional, specific method to check)",
        },
      },
      {
        action: "getAvailableHandlers",
        description: "List all available command handlers",
        args: {},
      },
      { action: "clearErrors", description: "Clear mod error log", args: {} },
] as const

export const PANEL_BRIDGE_CLIMATE_FLOAT_IDS = {
      0: "FLOAT_DESATURATION",
      1: "FLOAT_GLOBAL_LIGHT_INTENSITY",
      2: "FLOAT_NIGHT_STRENGTH",
      3: "FLOAT_PRECIPITATION_INTENSITY",
      4: "FLOAT_TEMPERATURE",
      5: "FLOAT_FOG_INTENSITY",
      6: "FLOAT_WIND_INTENSITY",
      7: "FLOAT_WIND_ANGLE_INTENSITY",
      8: "FLOAT_CLOUD_INTENSITY",
      9: "FLOAT_AMBIENT",
      10: "FLOAT_VIEW_DISTANCE",
      11: "FLOAT_DAYLIGHT_STRENGTH",
      12: "FLOAT_HUMIDITY",
} as const
