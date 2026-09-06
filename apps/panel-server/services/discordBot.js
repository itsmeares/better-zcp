import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActivityType,
  PermissionFlagsBits,
  MessageFlags,
  escapeMarkdown,
} from "discord.js";
import fs from "fs";
import path from "path";
import { request as undiciRequest, Headers as UndiciHeaders } from "undici";
import { STATUS_CODES } from "http";
import { types } from "util";
import { createLogger } from "../utils/logger.js";
const log = createLogger("Discord");
import { getActiveServer, getSetting, setSetting } from "../database/init.js";
import { loadUiSecret, writeUiSecretFile } from "../utils/uiSecretFile.ts";
import { sanitizeError } from "../utils/sanitize.ts";
import { describeStartFailure } from "./discordStartFailure.ts";
import { readIniValues } from "../utils/templateFiles.ts";
import { runManagedLifecycle } from "./managedContainer.js";
import { resolveObservedServerRunning } from "../utils/serverStatus.ts";
import {
  collectKnownSecretValues,
  redactKnownSecrets,
} from "../utils/discordMessageRedaction.ts";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "./lifecycleCoordinator.ts";

async function _resolveDiscordBody(body) {
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (types.isUint8Array(body)) return body;
  if (types.isArrayBuffer(body)) return new Uint8Array(body);
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof DataView) return new Uint8Array(body.buffer);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof FormData) return body;
  if (body[Symbol.iterator]) return Buffer.concat([...body]);
  if (body[Symbol.asyncIterator]) {
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  throw new TypeError("Unable to resolve body.");
}

async function _safeDiscordMakeRequest(url, init) {
  let body = await _resolveDiscordBody(init.body);
  if (typeof body === "string" && body) {
    try {
      const secrets = await collectKnownSecretValues();
      body = redactKnownSecrets(body, secrets);
    } catch (err) {
      log.error(`Discord outbound redaction check failed, blocking this send: ${err.message}`);
      throw err;
    }
  }
  const res = await undiciRequest(url, {
    ...init,
    body,
  });
  return {
    body: res.body,
    arrayBuffer: () => res.body.arrayBuffer(),
    json: () => res.body.json(),
    text: () => res.body.text(),
    get bodyUsed() {
      return res.body.bodyUsed;
    },
    headers: new UndiciHeaders(Object.fromEntries(Object.entries(res.headers))),
    status: res.statusCode,
    statusText: STATUS_CODES[res.statusCode] ?? "",
    ok: res.statusCode >= 200 && res.statusCode < 300,
  };
}

async function _resolveDiscordApplicationId(token) {
  if (!token) return null;

  const response = await fetch("https://discord.com/api/v10/users/@me", {
    headers: {
      Authorization: `Bot ${token}`,
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Discord identity lookup failed (${response.status})`);
  }

  const user = await response.json();
  return typeof user?.id === "string" && user.id ? user.id : null;
}

const PUBLIC_CHAT_TYPES = new Set([
  "General",
  "Say",
  "Local",
  "Shout",
  "Server Alert",
  "Server chat",
]);
const NO_YELL_CHAT_TYPES = new Set(
  [...PUBLIC_CHAT_TYPES].filter((t) => t !== "Shout"),
);
const GENERAL_ONLY_CHAT_TYPES = new Set(["General"]);
const CHAT_RELAY_SCOPES = new Set(["public", "no-yell", "general"]);

export function normalizeChatRelayScope(value) {
  return CHAT_RELAY_SCOPES.has(value) ? value : "public";
}

export function allowedChatTypesForScope(scope) {
  if (scope === "general") return GENERAL_ONLY_CHAT_TYPES;
  if (scope === "no-yell") return NO_YELL_CHAT_TYPES;
  return PUBLIC_CHAT_TYPES;
}

const DEFAULT_COMMAND_PERMISSIONS = {
  status: "everyone",
  players: "everyone",
  save: "moderator",
  broadcast: "moderator",
  kick: "moderator",
  start: "admin",
  stop: "admin",
  restart: "admin",
  rcon: "admin",
};

const LIFECYCLE_DEDUPE_WINDOW_MS = 60_000;
const PLAYER_PRESENCE_INTERVAL_MS = 60_000;
const GATEWAY_DEGRADED_THRESHOLD_MS = 30_000;

export class DiscordBot {
  constructor(rconService, serverManager, scheduler, logTailer = null) {
    this.client = null;
    this.rconService = rconService;
    this.serverManager = serverManager;
    this.scheduler = scheduler;
    this.logTailer = logTailer;
    this.token = null;
    this.guildId = null;
    this.adminRoleId = null;
    this.modRoleId = null;
    this.channelId = null;
    this.isRunning = false;
    this.lastStartError = null;
    this.webhookEvents = {};
    this.commandPermissions = { ...DEFAULT_COMMAND_PERMISSIONS };
    this.chatRelayEnabled = true;
    this.chatRelayChannelId = null;
    this.chatRelayScope = "public";
    this._presenceInterval = null;
    this._presenceUpdateInFlight = null;

    this._channelBreakers = new Map();

    this._gatewayDegradedSince = null;

    this._lastLifecycleState = null;
    this._lastLifecycleAt = 0;

    this._bridgeOfflineNoticeAt = 0;

    this._registerInFlight = null;

    this._registeredGuildId = null;

    this._onGameChat = null;
    this._chatRelayChain = Promise.resolve();
    this._chatRelayPending = 0;
    this._chatRelayDropped = 0;

    if (this.logTailer) {
      this._onGameChat = (data) => this._queueGameChat(data);
      this.logTailer.on("chatMessage", this._onGameChat);
    }
  }

  _queueGameChat(data) {
    const MAX_PENDING = 40;
    if (this._chatRelayPending >= MAX_PENDING) {
      this._chatRelayDropped++;
      if (this._chatRelayDropped % 25 === 1) {
        log.warn(
          `Chat relay is behind (${this._chatRelayPending} queued) — dropped ${this._chatRelayDropped} message(s) so far`,
        );
      }
      return;
    }
    this._chatRelayPending++;
    this._chatRelayChain = this._chatRelayChain
      .then(() => this.handleGameChat(data))
      .catch((e) => log.debug(`Game chat relay failed: ${e.message}`))
      .finally(() => {
        this._chatRelayPending--;
        if (this._chatRelayPending === 0 && this._chatRelayDropped > 0) {
          log.info(
            `Chat relay caught up — ${this._chatRelayDropped} message(s) were dropped while behind`,
          );
          this._chatRelayDropped = 0;
        }
      });
  }

  async handleGameChat(data) {
    if (!this.chatRelayEnabled || !this.isRunning || !this.client) return;

    const allowed = allowedChatTypesForScope(this.chatRelayScope);
    if (data?.sourceChatType) {
      if (!allowed.has(data.sourceChatType)) return;
    } else if (this.chatRelayScope === "general") {
      if (data?.type !== "general") return;
    } else if (data?.type !== "general" && data?.type !== "server") {
      return;
    }

    if (String(data?.message || "").startsWith("[Discord] ")) return;

    const serverMsg = String(data?.message || "");
    if (data?.type === "server" && serverMsg.startsWith("[SERVER] ")) {
      const isOutcome =
        serverMsg.includes("RESTARTING NOW") || serverMsg.includes("CANCELLED");
      if (!isOutcome) return;
    }

    const targetChannelId = this.chatRelayChannelId || this.channelId;
    if (!targetChannelId) return;
    log.debug(
      `Relaying game chat from ${data?.author || "unknown"} to Discord`,
    );

    const cleanMessage = escapeMarkdown(
      String(data.message || "")
        .replace(/@everyone/g, "(everyone)")
        .replace(/@here/g, "(here)")
        .slice(0, 1850),
      { maskedLink: true },
    );
    const cleanAuthor = escapeMarkdown(
      String(data.author || "unknown")
        .replace(/[\r\n]+/g, " ")
        .slice(0, 80),
      { maskedLink: true },
    );
    await this._sendToChannel(
      targetChannelId,
      `**<${cleanAuthor}>** ${cleanMessage}`,
      { label: "game chat relay" },
    );
  }

  async loadConfig() {
    log.info("Loading Discord bot config...");
    this.token = await loadUiSecret("discordBotToken", {
      legacyValue: await getSetting("discordBotToken"),
      clearLegacy: () => setSetting("discordBotToken", null),
      log,
    });
    this.guildId = await getSetting("discordGuildId");
    this.adminRoleId = await getSetting("discordAdminRoleId");
    this.modRoleId = await getSetting("discordModRoleId");
    this.channelId = await getSetting("discordChannelId");

    const savedPerms = await getSetting("discordCommandPermissions");
    if (savedPerms) {
      try {
        const parsed =
          typeof savedPerms === "string" ? JSON.parse(savedPerms) : savedPerms;
        this.commandPermissions = { ...DEFAULT_COMMAND_PERMISSIONS, ...parsed };
      } catch (e) {
        this.commandPermissions = { ...DEFAULT_COMMAND_PERMISSIONS };
      }
    }

    const chatRelayEnabled = await getSetting("discordChatRelayEnabled");
    this.chatRelayEnabled = chatRelayEnabled !== false;
    this.chatRelayChannelId =
      (await getSetting("discordChatRelayChannelId")) || null;
    this.chatRelayScope = normalizeChatRelayScope(
      await getSetting("discordChatRelayScope"),
    );

    const savedEvents = await getSetting("discordWebhookEvents");
    this.webhookEvents = {};
    if (savedEvents) {
      try {
        const parsed =
          typeof savedEvents === "string"
            ? JSON.parse(savedEvents)
            : savedEvents;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          this.webhookEvents = parsed;
        }
      } catch (e) {
        log.warn(`Failed to parse saved webhookEvents: ${e.message}`);
      }
    }
  }

  async saveWebhookEvents(events) {
    this.webhookEvents = events;
    await setSetting("discordWebhookEvents", JSON.stringify(events));
  }

  async sendEventNotification(eventType, variables = {}) {
    if (!this.isRunning || !this.channelId) return;

    const isLifecycle =
      eventType === "serverStart" || eventType === "serverStop";
    let newState = null;
    if (isLifecycle) {
      newState = eventType === "serverStart" ? "running" : "stopped";
      if (
        this._lastLifecycleState === newState &&
        Date.now() - this._lastLifecycleAt < LIFECYCLE_DEDUPE_WINDOW_MS
      ) {
        return;
      }
    }

    const event = this.webhookEvents[eventType];
    if (!event || !event.enabled || typeof event.template !== "string") {
      if (isLifecycle) {
        this._lastLifecycleState = newState;
        this._lastLifecycleAt = Date.now();
      }
      return;
    }

    let message = event.template;
    const keys = Object.keys(variables || {});
    if (keys.length > 0) {
      const escaped = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const re = new RegExp(`\\{(${escaped.join("|")})\\}`, "g");
      message = message.replace(re, (_, k) => {
        const v = variables[k];
        if (v === undefined || v === null) return "";
        return typeof v === "string" ? v : String(v);
      });
    }

    message = message
      .replace(/@everyone/g, "(everyone)")
      .replace(/@here/g, "(here)")
      .slice(0, 1900);

    if (!message.trim()) {
      log.warn(`Skipping ${eventType} notification: template rendered empty`);
      if (isLifecycle) {
        this._lastLifecycleState = newState;
        this._lastLifecycleAt = Date.now();
      }
      return;
    }

    const sent = await this.sendNotification(message);
    if (isLifecycle && sent) {
      this._lastLifecycleState = newState;
      this._lastLifecycleAt = Date.now();
    }
  }

  async updateConfig(token, guildId, adminRoleId, channelId, modRoleId) {
    writeUiSecretFile("discordBotToken", token);
    await setSetting("discordGuildId", guildId);
    await setSetting("discordAdminRoleId", adminRoleId || "");
    await setSetting("discordModRoleId", modRoleId || "");
    await setSetting("discordChannelId", channelId || "");

    const previousGuildId = this.guildId;
    const rolesChanged =
      this.adminRoleId !== (adminRoleId || null) ||
      this.modRoleId !== (modRoleId || null);
    this.token = token;
    this.guildId = guildId;
    this.adminRoleId = adminRoleId || null;
    this.modRoleId = modRoleId || null;
    this.channelId = channelId;

    if (
      this.isRunning &&
      this.client?.user &&
      previousGuildId &&
      previousGuildId !== guildId
    ) {
      try {
        const rest = new REST({
          version: "10",
          makeRequest: _safeDiscordMakeRequest,
        }).setToken(this.token);
        await rest.put(
          Routes.applicationGuildCommands(this.client.user.id, previousGuildId),
          { body: [] },
        );
        log.info(
          `Cleared slash commands from previous guild ${previousGuildId}`,
        );
      } catch (e) {
        log.warn(
          `Failed to clear commands from previous guild ${previousGuildId}: ${e.message}`,
        );
      }
      this._registeredGuildId = null;
    }

    if (rolesChanged && this.isRunning && this.client?.user) {
      try {
        await this.registerCommands();
      } catch (e) {
        log.warn(`Failed to re-register commands after role change: ${e.message}`);
      }
    }
  }

  async updateChatRelay(enabled, channelId, scope) {
    this.chatRelayEnabled = enabled;
    this.chatRelayChannelId = channelId || null;
    this.chatRelayScope = normalizeChatRelayScope(scope);
    await setSetting("discordChatRelayEnabled", enabled);
    await setSetting("discordChatRelayChannelId", channelId || "");
    await setSetting("discordChatRelayScope", this.chatRelayScope);
  }

  async resetConfig() {
    const token = this.token;
    const guildId = this.guildId;

    if (token && guildId) {
      try {
        const applicationId =
          this.client?.user?.id || (await _resolveDiscordApplicationId(token));

        if (applicationId) {
          const rest = new REST({
            version: "10",
            makeRequest: _safeDiscordMakeRequest,
          }).setToken(token);
          await rest.put(
            Routes.applicationGuildCommands(applicationId, guildId),
            { body: [] },
          );
          log.info(`Cleared slash commands from guild ${guildId}`);
        }
      } catch (error) {
        log.warn(
          `Failed to clear slash commands during Discord reset: ${error.message}`,
        );
      }
    }

    if (this.isRunning) {
      await this.stop();
    }

    writeUiSecretFile("discordBotToken", "");
    await setSetting("discordGuildId", "");
    await setSetting("discordAdminRoleId", "");
    await setSetting("discordModRoleId", "");
    await setSetting("discordChannelId", "");
    await setSetting("discordAutoStart", true);
    await setSetting("discordChatRelayEnabled", true);
    await setSetting("discordChatRelayChannelId", "");
    await setSetting("discordChatRelayScope", "public");
    await setSetting(
      "discordCommandPermissions",
      JSON.stringify(DEFAULT_COMMAND_PERMISSIONS),
    );
    await setSetting("discordWebhookEvents", JSON.stringify({}));

    this.token = null;
    this.guildId = null;
    this.adminRoleId = null;
    this.modRoleId = null;
    this.channelId = null;
    this.webhookEvents = {};
    this.commandPermissions = { ...DEFAULT_COMMAND_PERMISSIONS };
    this.chatRelayEnabled = true;
    this.chatRelayChannelId = null;
    this.chatRelayScope = "public";
    this._registeredGuildId = null;
    this._channelBreakers.clear();
    this._lastLifecycleState = null;
    this._lastLifecycleAt = 0;
  }

  async updateCommandPermissions(permissions) {
    const validLevels = ["everyone", "moderator", "admin"];
    const validCommands = Object.keys(DEFAULT_COMMAND_PERMISSIONS);
    const cleaned = {};
    for (const [cmd, level] of Object.entries(permissions)) {
      if (validCommands.includes(cmd) && validLevels.includes(level)) {
        cleaned[cmd] = level;
      }
    }
    this.commandPermissions = { ...DEFAULT_COMMAND_PERMISSIONS, ...cleaned };
    await setSetting(
      "discordCommandPermissions",
      JSON.stringify(this.commandPermissions),
    );

    if (this.isRunning && this.client?.user) {
      await this.registerCommands();
    }
    return this.commandPermissions;
  }

  getCommandPermissions() {
    return { ...this.commandPermissions };
  }

  getCommands() {
    const commands = [
      {
        builder: new SlashCommandBuilder()
          .setName("status")
          .setDescription("Get the current server status"),
        name: "status",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("players")
          .setDescription("List online players"),
        name: "players",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("start")
          .setDescription("Start the Project Zomboid server"),
        name: "start",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("stop")
          .setDescription("Stop the server (with save)"),
        name: "stop",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("restart")
          .setDescription("Restart the server with warning")
          .addIntegerOption((option) =>
            option
              .setName("minutes")
              .setDescription("Warning time in minutes before restart")
              .setRequired(false)
              .setMinValue(0)
              .setMaxValue(30),
          ),
        name: "restart",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("save")
          .setDescription("Save the world"),
        name: "save",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("broadcast")
          .setDescription("Send a message to all players")
          .addStringOption((option) =>
            option
              .setName("message")
              .setDescription("Message to broadcast")
              .setRequired(true),
          ),
        name: "broadcast",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("kick")
          .setDescription("Kick a player from the server")
          .addStringOption((option) =>
            option
              .setName("player")
              .setDescription("Player name to kick")
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("reason")
              .setDescription("Reason for kick")
              .setRequired(false),
          ),
        name: "kick",
      },
      {
        builder: new SlashCommandBuilder()
          .setName("rcon")
          .setDescription("Execute a custom RCON command")
          .addStringOption((option) =>
            option
              .setName("command")
              .setDescription("RCON command to execute")
              .setRequired(true),
          ),
        name: "rcon",
      },
    ];

    for (const cmd of commands) {
      const level = this.commandPermissions[cmd.name] || "admin";
      if (level === "admin" && !this.adminRoleId) {
        cmd.builder.setDefaultMemberPermissions(
          PermissionFlagsBits.Administrator,
        );
      } else if (level === "moderator" && !this.modRoleId && !this.adminRoleId) {
        cmd.builder.setDefaultMemberPermissions(
          PermissionFlagsBits.ManageMessages,
        );
      }
      // 'everyone' = no restriction set
    }

    return commands.map((c) => c.builder);
  }

  async registerCommands() {
    if (!this.token || !this.guildId) {
      throw new Error("Discord token and guild ID are required");
    }

    if (!this.client || !this.client.user) {
      throw new Error("Discord client not ready");
    }

    if (this._registerInFlight) {
      return this._registerInFlight;
    }

    const targetGuildId = this.guildId;
    const targetUserId = this.client.user.id;
    const rest = new REST({
      version: "10",
      makeRequest: _safeDiscordMakeRequest,
    }).setToken(this.token);
    const commands = this.getCommands().map((cmd) => cmd.toJSON());

    this._registerInFlight = (async () => {
      try {
        log.info("Registering Discord slash commands...");
        await rest.put(
          Routes.applicationGuildCommands(targetUserId, targetGuildId),
          { body: commands },
        );
        this._registeredGuildId = targetGuildId;
        log.info(`Registered ${commands.length} Discord commands`);
      } catch (error) {
        log.error(
          `Failed to register Discord commands: ${error.stack || error.message}`,
        );
        throw error;
      } finally {
        this._registerInFlight = null;
      }
    })();

    return this._registerInFlight;
  }

  hasRole(interaction, roleId) {
    if (!roleId) return false;
    const member = interaction.member;
    if (!member) return false;
    if (member.roles && member.roles.cache) {
      return member.roles.cache.has(roleId);
    }
    if (Array.isArray(member.roles)) {
      return member.roles.includes(roleId);
    }
    return false;
  }

  checkPermission(interaction, commandName) {
    const level = this.commandPermissions[commandName] || "admin";

    if (level === "everyone") return true;

    if (interaction.guild && interaction.guild.ownerId === interaction.user.id)
      return true;

    if (
      interaction.member &&
      typeof interaction.member.permissions?.has === "function" &&
      interaction.member.permissions.has(PermissionFlagsBits.Administrator)
    )
      return true;

    if (this.adminRoleId && this.hasRole(interaction, this.adminRoleId))
      return true;

    if (level === "moderator") {
      if (!this.modRoleId && !this.adminRoleId) return false;
      if (this.modRoleId && this.hasRole(interaction, this.modRoleId))
        return true;
      return false;
    }

    if (level === "admin") {
      if (!this.adminRoleId) return false;
      return false;
    }

    return false;
  }

  async handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    log.info(
      `Discord command: /${commandName} by ${interaction.user?.tag || "unknown"}`,
    );

    if (!this.checkPermission(interaction, commandName)) {
      const level = this.commandPermissions[commandName] || "admin";
      const roleName = level === "admin" ? "Admin" : "Moderator";
      await interaction.reply({
        content: `❌ You need the **${roleName}** role to use this command.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      switch (commandName) {
        case "status":
          await this.handleStatus(interaction);
          break;
        case "players":
          await this.handlePlayers(interaction);
          break;
        case "start":
          await this.handleStart(interaction);
          break;
        case "stop":
          await this.handleStop(interaction);
          break;
        case "restart":
          await this.handleRestart(interaction);
          break;
        case "save":
          await this.handleSave(interaction);
          break;
        case "broadcast":
          await this.handleBroadcast(interaction);
          break;
        case "kick":
          await this.handleKick(interaction);
          break;
        case "rcon":
          await this.handleRcon(interaction);
          break;
        default:
          await interaction.reply({
            content: "Unknown command",
            flags: MessageFlags.Ephemeral,
          });
      }
    } catch (error) {
      log.error(`command error: ${error.stack || error.message}`);
      try {
        const content = `❌ Error: ${sanitizeError(error.message)}`;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({
            content,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
      } catch (replyError) {
        log.error(
          `Failed to send error reply: ${replyError.stack || replyError.message}`,
        );
      }
    }
  }

  async handleStatus(interaction) {
    await interaction.deferReply();

    const status = await this.serverManager.getServerStatus();
    const observedRunning = await resolveObservedServerRunning(
      this.serverManager,
      this.rconService,
    );
    const isRunning = observedRunning === true;
    const statusUnknown = observedRunning === null;

    let uptimeStr = "N/A";
    if (status.uptime && status.uptime > 0) {
      const hours = Math.floor(status.uptime / 3600);
      const minutes = Math.floor((status.uptime % 3600) / 60);
      uptimeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    }

    const embed = new EmbedBuilder()
      .setTitle("🧟 Project Zomboid Server Status")
      .setColor(statusUnknown ? 0xffaa00 : isRunning ? 0x00ff00 : 0xff0000)
      .addFields(
        {
          name: "Status",
          value: statusUnknown
            ? "🟡 Unknown (detection failed)"
            : isRunning
              ? "🟢 Online"
              : "🔴 Offline",
          inline: true,
        },
        { name: "Uptime", value: uptimeStr, inline: true },
      )
      .setTimestamp();

    if (isRunning) {
      try {
        const players = await this.rconService.getPlayers();
        if (players.success) {
          embed.addFields({
            name: "Players Online",
            value: `${players.players?.length || 0}`,
            inline: true,
          });
        }
      } catch (e) {
        log.debug(`Discord status: RCON error for player count: ${e.message}`);
      }
    }

    await interaction.editReply({ embeds: [embed] });
  }

  async handlePlayers(interaction) {
    await interaction.deferReply();

    const observedRunning = await resolveObservedServerRunning(
      this.serverManager,
      this.rconService,
    );
    if (observedRunning === null) {
      await interaction.editReply(
        "🟡 Unable to verify server status — try again shortly.",
      );
      return;
    }
    if (!observedRunning) {
      await interaction.editReply("🔴 Server is offline");
      return;
    }

    if (!this.rconService?.connected) {
      await interaction.editReply(
        "❌ RCON is not connected — cannot list players.",
      );
      return;
    }

    const result = await this.rconService.getPlayers();

    if (!result.success) {
      await interaction.editReply(
        `❌ Failed to get players: ${sanitizeError(result.error)}`,
      );
      return;
    }

    const players = result.players || [];

    const MAX_DESC = 4000;
    let description;
    if (players.length === 0) {
      description = "No players online";
    } else {
      const lines = [];
      let total = 0;
      let truncated = 0;
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        const line = `• ${escapeMarkdown(String(typeof p === "object" ? (p.name ?? "") : p))}`;
        if (total + line.length + 1 > MAX_DESC) {
          truncated = players.length - i;
          break;
        }
        lines.push(line);
        total += line.length + 1;
      }
      if (truncated > 0) lines.push(`… and ${truncated} more`);
      description = lines.join("\n");
    }

    const embed = new EmbedBuilder()
      .setTitle("👥 Online Players")
      .setColor(0x3498db)
      .setDescription(description)
      .setFooter({ text: `${players.length} player(s)` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  async handleStart(interaction) {
    await interaction.deferReply();
    const activeServerForLock = await getActiveServer();
    const lifecycleLock = acquireLifecycleLock(
      "discord-start",
      activeServerForLock?.name || activeServerForLock?.serverName || null,
    );
    if (!lifecycleLock) {
      await interaction.editReply(lifecycleInProgressResponse().error);
      return;
    }

    try {
      const activeServer = activeServerForLock;
      const observedRunning = await resolveObservedServerRunning(
        this.serverManager,
        this.rconService,
      );
      if (observedRunning === null) {
        await interaction.editReply(
          "⚠️ Unable to verify whether the server is already running — refusing to start to avoid launching a second process. Check the panel UI directly.",
        );
        return;
      }
      if (observedRunning) {
        await interaction.editReply("⚠️ Server is already running");
        return;
      }

      const managed = await runManagedLifecycle("start", {
        serverId: activeServer?.id ?? null,
      });
      const started = managed.handled
        ? managed
        : await this.serverManager.startServer({
            serverId: activeServer?.id ?? null,
          });
      if (!started?.success) {
        await interaction.editReply(
          `❌ Failed to start the server: ${sanitizeError(started?.error || started?.message)}`,
        );
        return;
      }
      await interaction.editReply(
        started.alreadyRunning ? "✅ Server is already running" : "🚀 Server is starting...",
      );
      if (started.alreadyRunning) return;

      const safeTag = escapeMarkdown(String(interaction.user.tag));
      await this.sendNotification(`🚀 **Server started** by ${safeTag}`);
    } finally {
      lifecycleLock.release();
    }
  }

  async handleStop(interaction) {
    await interaction.deferReply();
    const activeServerForLock = await getActiveServer();
    const lifecycleLock = acquireLifecycleLock(
      "discord-stop",
      activeServerForLock?.name || activeServerForLock?.serverName || null,
    );
    if (!lifecycleLock) {
      await interaction.editReply(lifecycleInProgressResponse().error);
      return;
    }
    try {
      const activeServer = activeServerForLock;
      const observedRunning = await resolveObservedServerRunning(
        this.serverManager,
        this.rconService,
      );
      if (observedRunning === null) {
        await interaction.editReply(
          "⚠️ Unable to verify whether the server is running. Check the panel UI directly before retrying.",
        );
        return;
      }
      if (!observedRunning) {
        await interaction.editReply("⚠️ Server is not running");
        return;
      }

      if (!this.rconService?.connected) {
        await interaction.editReply(
          "❌ RCON is not connected — cannot gracefully stop the server. Use the panel UI to force-stop if needed.",
        );
        return;
      }

      const saved = await this.rconService.save();
      if (!saved?.success) {
        await interaction.editReply(
          `❌ Save failed, so the server was left running: ${sanitizeError(saved?.error)}`,
        );
        return;
      }
      const managed = await runManagedLifecycle("stop", {
        serverId: activeServer?.id ?? null,
      });
      const quit = managed.handled
        ? managed
        : await this.rconService.quit();
      if (!quit?.success) {
        await interaction.editReply(
          `❌ The world was saved, but the shutdown command failed: ${sanitizeError(quit?.error)}`,
        );
        return;
      }

      await interaction.editReply("🛑 Server is stopping...");
      const safeTag = escapeMarkdown(String(interaction.user.tag));
      await this.sendNotification(`🛑 **Server stopped** by ${safeTag}`);
    } finally {
      lifecycleLock.release();
    }
  }

  async handleRestart(interaction) {
    await interaction.deferReply();
    const lifecycleLock = acquireLifecycleLock(
      "discord-restart",
      this.serverManager?.serverName || null,
    );
    if (!lifecycleLock) {
      await interaction.editReply(lifecycleInProgressResponse().error);
      return;
    }

    try {
      const minutes = interaction.options.getInteger("minutes") ?? 5;

      const observedRunning = await resolveObservedServerRunning(
        this.serverManager,
        this.rconService,
      );
      if (observedRunning === null) {
        await interaction.editReply(
          "⚠️ Unable to verify whether the server is running. Check the panel UI directly before retrying.",
        );
        return;
      }
      if (!observedRunning) {
        await interaction.editReply(
          "⚠️ Server is not running. Use /start to start the server.",
        );
        return;
      }

      if (!this.rconService?.connected) {
        await interaction.editReply(
          "❌ RCON is not connected — cannot send the restart warning. Try again once RCON reconnects.",
        );
        return;
      }

      await interaction.editReply(
        `🔄 Server restart initiated (${minutes} min warning)`,
      );
      const safeTag = escapeMarkdown(String(interaction.user.tag));
      await this.sendNotification(
        `🔄 **Server restart** initiated by ${safeTag}`,
      );

      try {
        const result = await this.scheduler.performRestart(minutes, {
          lifecycleLock,
        });
        if (!result?.success) {
          await this._reportRestartOutcome(
            interaction,
            `❌ Restart did not complete: ${sanitizeError(result?.message || "unknown error")}`,
          );
        }
      } catch (error) {
        log.error(`restart failed: ${error.message}`);
        await this._reportRestartOutcome(
          interaction,
          `❌ Server restart failed: ${sanitizeError(error.message)}`,
        );
      }
    } finally {
      lifecycleLock.release();
    }
  }

  async _reportRestartOutcome(interaction, text) {
    try {
      await interaction.editReply(text);
    } catch {
      await this.sendNotification(text);
    }
  }

  async handleSave(interaction) {
    await interaction.deferReply();

    if (!this.rconService?.connected) {
      await interaction.editReply("❌ RCON is not connected — cannot save.");
      return;
    }

    const result = await this.rconService.save();

    if (result.success) {
      await interaction.editReply("💾 World saved successfully");
    } else {
      await interaction.editReply(
        `❌ Save failed: ${sanitizeError(result.error)}`,
      );
    }
  }

  async handleBroadcast(interaction) {
    const message = interaction.options.getString("message");

    await interaction.deferReply();

    if (!this.rconService?.connected) {
      await interaction.editReply(
        "❌ RCON is not connected — cannot broadcast.",
      );
      return;
    }

    const safeMessage = String(message)
      .replace(/[\r\n]+/g, " ")
      .slice(0, 200);

    const result = await this.rconService.serverMessage(safeMessage);

    if (result.success) {
      await interaction.editReply(
        `📢 Broadcast sent: "${escapeMarkdown(safeMessage)}"`,
      );
    } else {
      await interaction.editReply(
        `❌ Broadcast failed: ${sanitizeError(result.error)}`,
      );
    }
  }

  async handleKick(interaction) {
    const player = interaction.options.getString("player");
    const reason = interaction.options.getString("reason") || "No reason given";

    await interaction.deferReply();

    if (!this.rconService?.connected) {
      await interaction.editReply("❌ RCON is not connected — cannot kick.");
      return;
    }

    const safePlayer = this.rconService.sanitize(player);
    if (!safePlayer) {
      await interaction.editReply("❌ Invalid player name.");
      return;
    }
    const result = await this.rconService.execute(`kickuser "${safePlayer}"`);

    if (result.success) {
      const safeName = escapeMarkdown(String(player));
      const safeTag = escapeMarkdown(String(interaction.user.tag));
      const safeReason = escapeMarkdown(String(reason));
      await interaction.editReply(`👢 Kicked ${safeName}: ${safeReason}`);
      await this.sendNotification(
        `👢 **${safeName}** was kicked by ${safeTag}\nReason: ${safeReason}`,
      );
    } else {
      await interaction.editReply(
        `❌ Kick failed: ${sanitizeError(result.error)}`,
      );
    }
  }

  async handleRcon(interaction) {
    const command = interaction.options.getString("command");

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!this.rconService?.connected) {
      await interaction.editReply("❌ RCON is not connected.");
      return;
    }

    const trimmed = String(command).slice(0, 500);
    const safeCommand = this.rconService.sanitize(trimmed);
    if (!safeCommand) {
      await interaction.editReply("❌ Empty or invalid command.");
      return;
    }
    const result = await this.rconService.execute(safeCommand);

    const rawResponse = String(result.response || "No response")
      .replace(/`{3,}/g, "\u02cb\u02cb\u02cb")
      .slice(0, 1800);
    const response = result.success
      ? `✅ **Response:**\n\`\`\`${rawResponse}\`\`\``
      : `❌ **Error:** ${sanitizeError(result.error)}`;

    await interaction.editReply(response);
  }

  async sendNotification(message) {
    if (!this.channelId || !this.client) return false;
    log.info(
      `Sending Discord notification: ${String(message).substring(0, 80)}`,
    );
    return await this._sendToChannel(this.channelId, message, {
      label: "notification",
    });
  }

  async _sendToChannel(channelId, message, { label = "message" } = {}) {
    if (!channelId || !this.client) return false;

    const FAILURE_THRESHOLD = 3;
    const COOLDOWN_MS = 5 * 60 * 1000;
    const SEND_TIMEOUT_MS = 30 * 1000;
    const now = Date.now();
    const breaker = this._breakerFor(channelId);

    if (now < breaker.openUntil) {
      breaker.suppressed++;
      return false;
    }

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased?.() || typeof channel.send !== "function") {
        throw new Error("Configured channel is not a sendable text channel");
      }
      const sendPromise = channel.send(message);
      sendPromise.catch(() => {});
      await Promise.race([
        sendPromise,
        new Promise((_resolve, reject) =>
          setTimeout(() => {
            const timeoutError = new Error(
              `Discord send timed out after ${SEND_TIMEOUT_MS}ms (ETIMEDOUT)`,
            );
            timeoutError.code = "ETIMEDOUT";
            reject(timeoutError);
          }, SEND_TIMEOUT_MS),
        ),
      ]);
      if (breaker.failures > 0 || breaker.suppressed > 0) {
        if (breaker.suppressed > 0) {
          log.info(
            `Discord channel ${channelId} recovered — ${breaker.suppressed} send(s) were suppressed during the outage`,
          );
        }
        breaker.failures = 0;
        breaker.suppressed = 0;
      }
      return true;
    } catch (error) {
      breaker.failures++;
      const transient =
        (typeof error.status === "number" &&
          error.status >= 500 &&
          error.status < 600) ||
        /EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|Connect Timeout|fetch failed|UND_ERR/i.test(
          error.message || "",
        );

      if (breaker.failures >= FAILURE_THRESHOLD) {
        const cooldown = transient ? COOLDOWN_MS : COOLDOWN_MS * 6;
        breaker.openUntil = now + cooldown;
        const kind = transient
          ? "unreachable"
          : "misconfigured (likely channel/perms)";
        log.error(
          `Discord ${kind} for channel ${channelId} (${breaker.failures} consecutive failures): ${error.message}. Suppressing ${label} sends for ${Math.round(cooldown / 60000)} min.`,
        );
      } else {
        log.error(`Failed to send Discord ${label}: ${error.message}`);
      }
      return false;
    }
  }

  _breakerFor(channelId) {
    let breaker = this._channelBreakers.get(channelId);
    if (!breaker) {
      breaker = { failures: 0, openUntil: 0, suppressed: 0 };
      this._channelBreakers.set(channelId, breaker);
    }
    return breaker;
  }

  async getConfiguredMaxPlayers() {
    try {
      const activeServer = await getActiveServer();
      const serverName = activeServer?.serverName || (await getSetting("serverName"));
      const configPath =
        activeServer?.serverConfigPath ||
        (activeServer?.zomboidDataPath
          ? path.join(activeServer.zomboidDataPath, "Server")
          : await getSetting("serverConfigPath")) ||
        ((await getSetting("zomboidDataPath"))
          ? path.join(await getSetting("zomboidDataPath"), "Server")
          : null);

      if (
        !configPath ||
        !serverName ||
        typeof serverName !== "string" ||
        path.basename(serverName) !== serverName ||
        serverName.includes("..")
      ) {
        return null;
      }

      const iniPath = path.join(configPath, `${serverName}.ini`);
      if (!fs.existsSync(iniPath)) return null;

      const content = fs.readFileSync(iniPath, "utf8");
      const maxPlayers = Number.parseInt(
        readIniValues(content, ["MaxPlayers"]).MaxPlayers,
        10,
      );
      return Number.isInteger(maxPlayers) && maxPlayers > 0 ? maxPlayers : null;
    } catch (error) {
      log.debug(`Could not read MaxPlayers for Discord presence: ${error.message}`);
      return null;
    }
  }

  async updatePlayerPresence() {
    if (!this.isRunning || !this.client?.user || !this.serverManager) return;
    if (this._presenceUpdateInFlight) return this._presenceUpdateInFlight;

    this._presenceUpdateInFlight = (async () => {
      let activity = "Server offline";
      try {
        const observedRunning = await resolveObservedServerRunning(
          this.serverManager,
          this.rconService,
        );
        if (observedRunning === null) {
          activity = "Status unknown";
        } else if (observedRunning) {
          if (this.rconService?.connected) {
            const result = await this.rconService.getPlayers();
            if (result?.success) {
              const count = Array.isArray(result.players)
                ? result.players.length
                : 0;
              const maxPlayers = await this.getConfiguredMaxPlayers();
              activity = maxPlayers ? `${count}/${maxPlayers}` : `${count} online`;
            } else {
              activity = "Players unavailable";
            }
          } else {
            activity = "Players unavailable";
          }
        }

        if (this.isRunning && this.client?.user) {
          await this.client.user.setActivity(activity, {
            type: ActivityType.Playing,
          });
        }
      } catch (error) {
        log.debug(`Discord presence update failed: ${error.message}`);
      } finally {
        this._presenceUpdateInFlight = null;
      }
    })();

    return this._presenceUpdateInFlight;
  }

  _startPresenceUpdates() {
    if (this._presenceInterval || !this.client?.user) return;
    void this.updatePlayerPresence();
    this._presenceInterval = setInterval(() => {
      void this.updatePlayerPresence();
    }, PLAYER_PRESENCE_INTERVAL_MS);
  }

  _stopPresenceUpdates() {
    if (this._presenceInterval) {
      clearInterval(this._presenceInterval);
      this._presenceInterval = null;
    }
  }

  async start() {
    if (this.isRunning || this.client) {
      log.warn("start() called while bot is already running — ignoring");
      return true;
    }

    await this.loadConfig();

    if (this.logTailer && !this._onGameChat) {
      this._onGameChat = (data) => this._queueGameChat(data);
      this.logTailer.on("chatMessage", this._onGameChat);
    }

    if (!this.token) {
      log.info("bot not configured (no token)");
      this.lastStartError = { kind: "NoToken", message: "No bot token is configured." };
      return false;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers, // Required for role checks
        GatewayIntentBits.MessageContent, // Required for reading chat messages
      ],
      allowedMentions: { parse: [] },
      rest: { makeRequest: _safeDiscordMakeRequest },
    });

    const CHAT_BRIDGE_LIMIT = 5;
    const CHAT_BRIDGE_WINDOW_MS = 10_000;
    const chatBridgeRate = new Map();
    this.client.on("messageCreate", async (message) => {
      if (!this.isRunning || message.author.bot) return;
      if (message.system) return;

      if (!this.chatRelayEnabled) return;

      const relayChannelId = this.chatRelayChannelId || this.channelId;
      if (!relayChannelId) return;
      if (message.channelId === relayChannelId) {
        try {
          if (this.rconService && this.rconService.connected) {
            const user = message.author.username;
            const userId = message.author.id;
            let content = message.content;
            if (!content) return;

            const now = Date.now();
            const hits = (chatBridgeRate.get(userId) || []).filter(
              (t) => now - t < CHAT_BRIDGE_WINDOW_MS,
            );
            if (hits.length >= CHAT_BRIDGE_LIMIT) {
              log.debug(`Chat bridge rate-limited user ${user} (${userId})`);
              return;
            }
            hits.push(now);
            chatBridgeRate.set(userId, hits);
            if (chatBridgeRate.size > 200) {
              for (const [id, ts] of chatBridgeRate) {
                if (!ts.some((t) => now - t < CHAT_BRIDGE_WINDOW_MS))
                  chatBridgeRate.delete(id);
              }
            }

            let resolved = content
              // User mentions: <@id> or <@!id>
              .replace(/<@!?(\d+)>/g, (_, id) => {
                const u = message.mentions?.users?.get(id);
                return u ? `@${u.username}` : "@user";
              })
              // Role mentions: <@&id>
              .replace(/<@&(\d+)>/g, (_, id) => {
                const r = message.mentions?.roles?.get(id);
                return r ? `@${r.name}` : "@role";
              })
              // Channel mentions: <#id>
              .replace(/<#(\d+)>/g, (_, id) => {
                const c = message.mentions?.channels?.get(id);
                return c ? `#${c.name}` : "#channel";
              })
              // Custom emoji: <:name:id> or <a:name:id>
              .replace(/<a?:([^:>]+):\d+>/g, ":$1:");

            const safeUser = user.slice(0, 50);
            const safeMsg = resolved.replace(/[\r\n]+/g, " ").slice(0, 200);
            if (!safeMsg.trim()) return;
            const relayed = await this.rconService.serverMessage(
              `[Discord] ${safeUser}: ${safeMsg}`,
            );
            if (!relayed?.success) {
              const now = Date.now();
              if (now - this._bridgeOfflineNoticeAt > 60_000) {
                this._bridgeOfflineNoticeAt = now;
                await message.reply(
                  "⚠️ The game server rejected that message, so it was not delivered in-game.",
                );
              }
            }
          } else {
            const now = Date.now();
            if (now - this._bridgeOfflineNoticeAt > 60_000) {
              this._bridgeOfflineNoticeAt = now;
              await message.reply(
                "⚠️ The game server is unreachable right now, so that message was not delivered in-game.",
              );
            }
          }
        } catch (e) {
          log.warn(`Failed to bridge message to server: ${e.message}`);
        }
      }
    });

    this.client.on("interactionCreate", async (interaction) => {
      try {
        await this.handleInteraction(interaction);
      } catch (error) {
        log.error(`interaction handler error: ${error.message}`);
      }
    });

    this.client.on("error", (error) => {
      log.error(`client error: ${error.stack || error.message}`);
    });

    this.client.on("shardReconnecting", () => {
      if (!this._gatewayDegradedSince) this._gatewayDegradedSince = Date.now();
    });
    this.client.on("shardDisconnect", (event) => {
      if (!this._gatewayDegradedSince) this._gatewayDegradedSince = Date.now();
      log.error(
        `Discord gateway shard disconnected and will not reconnect on its own (code ${event?.code}).`,
      );
    });
    this.client.on("shardResume", () => {
      this._gatewayDegradedSince = null;
    });
    this.client.on("shardReady", () => {
      this._gatewayDegradedSince = null;
    });

    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const timeoutError = new Error("Bot ready timeout after 30s");
          timeoutError.code = "ReadyTimeout";
          reject(timeoutError);
        }, 30000);
        this.client.once("clientReady", async () => {
          clearTimeout(timeout);
          log.info(`bot logged in as ${this.client.user.tag}`);
          try {
            await this.registerCommands();
          } catch (e) {
            log.warn(`Failed to register slash commands: ${e.message}`);
          }
          this.isRunning = true;
          this.lastStartError = null;
          this._startPresenceUpdates();
          resolve();
        });
        this.client.login(this.token).catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
      return true;
    } catch (error) {
      log.error(`Failed to start Discord bot: ${error.message}`);
      this.lastStartError = { kind: error.code || null, message: error.message };
      if (this.logTailer && this._onGameChat) {
        try {
          this.logTailer.off("chatMessage", this._onGameChat);
        } catch {
          /* noop */
        }
        this._onGameChat = null;
      }
      if (this.client) {
        try {
          this.client.destroy();
        } catch (destroyError) {
          log.debug(`Discord client destroy failed: ${destroyError.message}`);
        }
        this.client = null;
      }
      this.isRunning = false;
      this._stopPresenceUpdates();
      return false;
    }
  }
  async stop() {
    this._stopPresenceUpdates();
    if (this.logTailer && this._onGameChat) {
      try {
        this.logTailer.off("chatMessage", this._onGameChat);
      } catch {
        /* noop */
      }
      this._onGameChat = null;
    }
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      this.isRunning = false;
      this._lastLifecycleState = null;
      this._lastLifecycleAt = 0;
      this._channelBreakers.clear();
      this._gatewayDegradedSince = null;
      this._chatRelayChain = Promise.resolve();
      this._chatRelayPending = 0;
      this._chatRelayDropped = 0;
      this._registerInFlight = null;
      this._registeredGuildId = null;
      log.info("bot stopped");
    }
  }

  getStatus() {
    const gatewayIssue = Boolean(
      this._gatewayDegradedSince &&
        Date.now() - this._gatewayDegradedSince >= GATEWAY_DEGRADED_THRESHOLD_MS,
    );
    return {
      running: this.isRunning,
      configured: !!this.token,
      username: this.client?.user?.tag || null,
      guildId: this.guildId,
      channelId: this.channelId,
      modRoleId: this.modRoleId || null,
      lastStartError: this.lastStartError
        ? { kind: this.lastStartError.kind, message: describeStartFailure(this.lastStartError) }
        : null,
      gatewayIssue,
      gatewayDegradedSince: gatewayIssue
        ? new Date(this._gatewayDegradedSince).toISOString()
        : null,
    };
  }
}
