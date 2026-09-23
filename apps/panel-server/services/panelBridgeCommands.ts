export const PANEL_BRIDGE_COMMANDS = [
      { action: "ping", description: "Health check", args: {} },
      {
        action: "getServerInfo",
        description: "Get server info and player list",
        args: {},
      },
      { action: "saveWorld", description: "Trigger world save", args: {} },

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
        action: "sendToServerChat",
        description:
          "Send message to server chat (isAlert=true for system announcement)",
        args: {
          message: "string (required)",
          isAlert: "boolean (default: false)",
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
