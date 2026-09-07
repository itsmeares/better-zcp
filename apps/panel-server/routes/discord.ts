import express from "express";
import type { Request } from "express";
import { createLogger } from "../utils/logger.ts";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.ts";
import { normalizeChatRelayScope } from "../services/discordBot.ts";
import { describeStartFailure } from "../services/discordStartFailure.ts";
import { requirePermission, getRoleByName } from "../services/permissions.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
const log = createLogger("API:Discord");

const router = express.Router();

type AuthenticatedRequest = Request & {
  user?: { role?: string } | null;
};

type DiscordEvent = {
  enabled: boolean;
  template: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DISCORD_COMMAND_CAPABILITY: Record<string, string | null> = {
  status: null,
  players: "players.view",
  save: "server.control",
  broadcast: "server.world_events",
  kick: "players.moderate",
  start: "server.control",
  stop: "server.control",
  restart: "server.control",
  rcon: "rcon.execute",
};

router.use(requirePermission("integrations.manage"));

router.get("/status", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.json({
        running: false,
        configured: false,
        error: "Discord bot not initialized",
      });
    }

    const status = discordBot.getStatus();
    res.json(status);
  } catch (error: unknown) {
    log.error(`Failed to get Discord bot status: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/config", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    await discordBot.loadConfig();

    const { getSetting } = await import("../database/init.js");
    const autoStart = await getSetting("discordAutoStart");

    res.json({
      token: discordBot.token ? "••••••••" + discordBot.token.slice(-4) : null,
      hasToken: !!discordBot.token,
      guildId: discordBot.guildId,
      adminRoleId: discordBot.adminRoleId,
      modRoleId: discordBot.modRoleId,
      channelId: discordBot.channelId,
      autoStart: autoStart !== false, // default true
      chatRelayEnabled: discordBot.chatRelayEnabled !== false,
      chatRelayChannelId: discordBot.chatRelayChannelId || "",
      chatRelayScope: normalizeChatRelayScope(discordBot.chatRelayScope),
    });
  } catch (error: unknown) {
    log.error(`Failed to get Discord config: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.put("/config", async (req, res) => {
  try {
    const {
      token,
      guildId,
      adminRoleId,
      modRoleId,
      channelId,
      autoStart,
      chatRelayEnabled,
      chatRelayChannelId,
      chatRelayScope,
    } = req.body;
    log.info(
      `PUT /config: guildId=${guildId}, token=${token ? (token === "KEEP_EXISTING" ? "KEEP" : "***") : "none"}, autoStart=${autoStart}`,
    );

    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    await discordBot.loadConfig();

    const finalToken =
      token === "KEEP_EXISTING" && discordBot.token ? discordBot.token : token;

    if (!finalToken || !guildId) {
      return res.status(400).json({
        error: "Token and Guild ID are required",
        code: ErrorCode.DISCORD_TOKEN_AND_GUILD_REQUIRED,
      });
    }

    const SNOWFLAKE = /^\d{15,21}$/;
    if (!SNOWFLAKE.test(guildId)) {
      return res.status(400).json({
        error: "Invalid Guild ID format (must be a Discord Snowflake)",
        code: ErrorCode.DISCORD_INVALID_GUILD_ID,
      });
    }
    if (adminRoleId && !SNOWFLAKE.test(adminRoleId)) {
      return res.status(400).json({
        error: "Invalid Admin Role ID format",
        code: ErrorCode.DISCORD_INVALID_ADMIN_ROLE_ID,
      });
    }
    if (modRoleId && !SNOWFLAKE.test(modRoleId)) {
      return res.status(400).json({
        error: "Invalid Mod Role ID format",
        code: ErrorCode.DISCORD_INVALID_MOD_ROLE_ID,
      });
    }
    if (channelId && !SNOWFLAKE.test(channelId)) {
      return res.status(400).json({
        error: "Invalid Channel ID format",
        code: ErrorCode.DISCORD_INVALID_CHANNEL_ID,
      });
    }
    if (chatRelayChannelId && !SNOWFLAKE.test(chatRelayChannelId)) {
      return res.status(400).json({
        error: "Invalid Chat Relay Channel ID format",
        code: ErrorCode.DISCORD_INVALID_CHAT_RELAY_CHANNEL_ID,
      });
    }
    if (
      chatRelayScope !== undefined &&
      chatRelayScope !== "public" &&
      chatRelayScope !== "no-yell" &&
      chatRelayScope !== "general"
    ) {
      return res.status(400).json({
        error: "Invalid Chat Relay Scope",
        code: ErrorCode.DISCORD_INVALID_CHAT_RELAY_SCOPE,
      });
    }

    const prevToken = discordBot.token;
    const prevGuildId = discordBot.guildId;

    await discordBot.updateConfig(
      finalToken,
      guildId,
      adminRoleId,
      channelId,
      modRoleId,
    );

    if (typeof autoStart === "boolean") {
      const { setSetting } = await import("../database/init.js");
      await setSetting("discordAutoStart", autoStart);
    }

    if (
      typeof chatRelayEnabled === "boolean" ||
      typeof chatRelayChannelId === "string" ||
      typeof chatRelayScope === "string"
    ) {
      await discordBot.updateChatRelay(
        typeof chatRelayEnabled === "boolean"
          ? chatRelayEnabled
          : discordBot.chatRelayEnabled,
        typeof chatRelayChannelId === "string"
          ? chatRelayChannelId
          : discordBot.chatRelayChannelId,
        typeof chatRelayScope === "string"
          ? chatRelayScope
          : discordBot.chatRelayScope,
      );
    }

    const credentialsChanged =
      prevToken !== finalToken || prevGuildId !== (guildId || null);
    if (discordBot.isRunning && credentialsChanged) {
      await discordBot.stop();
      const started = await discordBot.start();
      if (!started) {
        return res.json({
          success: true,
          message: "Discord bot configuration saved, but the bot failed to reconnect.",
          botStarted: false,
          botStartError: describeStartFailure(discordBot.lastStartError),
        });
      }
    }

    res.json({
      success: true,
      message: "Discord bot configuration updated",
    });
  } catch (error: unknown) {
    log.error(`Failed to update Discord config: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/start", async (req, res) => {
  try {
    log.info("POST /start — starting Discord bot");
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    if (discordBot.isRunning) {
      return res.json({ success: true, message: "Bot is already running" });
    }

    const started = await discordBot.start();

    if (started) {
      res.json({ success: true, message: "Discord bot started" });
    } else {
      const reason = describeStartFailure(discordBot.lastStartError);
      res.status(400).json({
        error: reason,
        code: ErrorCode.DISCORD_START_FAILED,
        params: sanitizeErrorParams({ reason }),
      });
    }
  } catch (error: unknown) {
    log.error(`Failed to start Discord bot: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/stop", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    if (!discordBot.isRunning) {
      return res.json({ success: true, message: "Bot is not running" });
    }

    await discordBot.stop();
    res.json({ success: true, message: "Discord bot stopped" });
  } catch (error: unknown) {
    log.error(`Failed to stop Discord bot: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/reset", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    await discordBot.resetConfig();
    res.json({
      success: true,
      message: "Discord bot settings wiped. Setup can start from scratch.",
    });
  } catch (error: unknown) {
    log.error(`Failed to reset Discord config: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/test", async (req, res) => {
  try {
    const { token } = req.body || {};

    if (typeof token !== "string" || token.length === 0 || token.length > 200) {
      return res.status(400).json({
        error: "Token must be a non-empty string (max 200 chars)",
        code: ErrorCode.DISCORD_TEST_TOKEN_INVALID_INPUT,
      });
    }
    if (!/^[A-Za-z0-9._-]+$/.test(token)) {
      return res.status(400).json({
        error: "Invalid token format",
        code: ErrorCode.DISCORD_TEST_TOKEN_INVALID_FORMAT,
      });
    }

    const response = await fetch("https://discord.com/api/v10/users/@me", {
      headers: {
        Authorization: `Bot ${token}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return res.status(429).json({
          error: "Discord is rate-limiting this request. Wait a moment and try again.",
          code: ErrorCode.DISCORD_TEST_RATE_LIMITED,
        });
      }
      if (response.status >= 500) {
        const message = `Discord's API is unavailable right now (HTTP ${response.status}). This isn't your token -- try again shortly.`;
        return res.status(502).json({
          error: message,
          code: ErrorCode.DISCORD_TEST_API_UNAVAILABLE,
          params: sanitizeErrorParams({ status: response.status }),
        });
      }
      if (response.status !== 401) {
        const message = `Discord rejected the request (HTTP ${response.status}).`;
        return res.status(400).json({
          error: message,
          code: ErrorCode.DISCORD_TEST_REQUEST_REJECTED,
          params: sanitizeErrorParams({ status: response.status }),
        });
      }
      return res.status(400).json({
        error: "Invalid token",
        code: ErrorCode.DISCORD_TEST_TOKEN_INVALID,
      });
    }

    const userData = await response.json();

    const permissions = 84992;
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${userData.id}&permissions=${permissions}&scope=bot%20applications.commands`;

    res.json({
      success: true,
      bot: {
        username: userData.username,
        id: userData.id,
        discriminator: userData.discriminator,
        avatar: userData.avatar
          ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png?size=128`
          : null,
      },
      inviteUrl,
    });
  } catch (error: unknown) {
    log.error(`Discord test failed: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/test-message", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");

    if (!discordBot) {
      return res.status(400).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    if (!discordBot.isRunning) {
      return res.status(400).json({
        error: "Bot is not running",
        code: ErrorCode.DISCORD_BOT_NOT_RUNNING,
      });
    }

    const sent = await discordBot.sendNotification(
      "🧪 **Test message** from PZ Server Manager",
    );
    if (!sent) {
      return res.status(502).json({
        error:
          "Discord rejected the message. Check the notification channel ID and that the bot can post there.",
        code: ErrorCode.DISCORD_TEST_MESSAGE_REJECTED,
      });
    }
    res.json({ success: true, message: "Test message sent" });
  } catch (error: unknown) {
    log.error(`Failed to send test message: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/webhook-events", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.json({ events: {} });
    }

    const defaultEvents = {
      serverStart: {
        enabled: false,
        template:
          "🟢 **Server Started**\nThe Project Zomboid server is now online!",
      },
      serverStop: {
        enabled: false,
        template: "🔴 **Server Stopped**\nThe server has been shut down.",
      },
      playerJoin: {
        enabled: false,
        template: "👋 **{player}** joined the server",
      },
      playerLeave: {
        enabled: false,
        template: "👋 **{player}** left the server",
      },
      scheduledRestart: {
        enabled: false,
        template:
          "⏰ **Scheduled Restart**\nServer will restart in {minutes} minutes",
      },
      backupComplete: {
        enabled: false,
        template: "💾 **Backup Complete**\nBackup created successfully",
      },
      playerDeath: { enabled: false, template: "💀 **{player}** has died" },
    };

    const savedEvents = discordBot.webhookEvents || {};
    const events = { ...defaultEvents, ...savedEvents };

    res.json({ events });
  } catch (error: unknown) {
    log.error(`Failed to get webhook events: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.put("/webhook-events", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    const { events } = req.body;
    if (!events || typeof events !== "object") {
      return res.status(400).json({
        error: "Events configuration required",
        code: ErrorCode.DISCORD_EVENTS_CONFIG_REQUIRED,
      });
    }

    const VALID_EVENT_KEYS = [
      "serverStart",
      "serverStop",
      "playerJoin",
      "playerLeave",
      "scheduledRestart",
      "backupComplete",
      "playerDeath",
    ];

    const sanitizedEvents: Record<string, DiscordEvent> = {};
    for (const key of VALID_EVENT_KEYS) {
      if (events[key] && typeof events[key] === "object") {
        const template =
          typeof events[key].template === "string"
            ? events[key].template.slice(0, 500)
            : "";
        sanitizedEvents[key] = {
          enabled: !!events[key].enabled && template.trim().length > 0,
          template,
        };
      }
    }

    const merged = { ...(discordBot.webhookEvents || {}), ...sanitizedEvents };
    await discordBot.saveWebhookEvents(merged);

    res.json({ success: true, message: "Webhook events updated" });
  } catch (error: unknown) {
    log.error(`Failed to update webhook events: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/permissions", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    res.json({ permissions: discordBot.getCommandPermissions() });
  } catch (error: unknown) {
    log.error(`Failed to get command permissions: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.put("/permissions", async (req, res) => {
  try {
    const discordBot = req.app.get("discordBot");
    if (!discordBot) {
      return res.status(500).json({
        error: "Discord bot not initialized",
        code: ErrorCode.DISCORD_BOT_NOT_INITIALIZED,
      });
    }

    const { permissions } = req.body;
    if (!permissions || typeof permissions !== "object") {
      return res.status(400).json({
        error: "Permissions object required",
        code: ErrorCode.DISCORD_PERMISSIONS_OBJECT_REQUIRED,
      });
    }

    const current = discordBot.getCommandPermissions();
    const missing = [];
    let callerCapabilities = null;
    for (const [command, tier] of Object.entries(permissions)) {
      const requiredCapability = DISCORD_COMMAND_CAPABILITY[command];
      if (!requiredCapability) continue;
      if (!(command in current) || current[command] === tier) continue;
      if (callerCapabilities === null) {
        const user = (req as AuthenticatedRequest).user;
        const role = user?.role ? await getRoleByName(user.role) : null;
        callerCapabilities = Array.isArray(role?.capabilities)
          ? role.capabilities
          : [];
      }
      if (!callerCapabilities.includes(requiredCapability)) {
        missing.push({ command, requiredCapability });
      }
    }
    if (missing.length > 0) {
      const detail = missing
        .map((m) => `"${m.command}" needs ${m.requiredCapability}`)
        .join(", ");
      return res.status(403).json({
        error: `Cannot change the Discord tier for ${detail} without holding that capability yourself.`,
        code: ErrorCode.DISCORD_PERMISSIONS_CAPABILITY_REQUIRED,
        params: sanitizeErrorParams({ detail }),
        missing,
      });
    }

    const updated = await discordBot.updateCommandPermissions(permissions);
    res.json({ success: true, permissions: updated });
  } catch (error: unknown) {
    log.error(`Failed to update command permissions: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

export default router;
