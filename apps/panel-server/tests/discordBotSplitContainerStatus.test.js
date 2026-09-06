import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-09-01 Discord report (user Deide): panel and PZ in SEPARATE
// containers -> every Discord command that answers "is the server up" said
// no, even with RCON connected. handleStatus/handlePlayers/handleStart/
// handleStop/handleRestart/updatePlayerPresence all used to read
// serverManager.getServerProcessDetails().running ALONE. Now they all go
// through resolveObservedServerRunning(), the same OR-of-every-signal
// verdict the dashboard badge and status watchdog use.
//
// THE TEST THAT MATTERS: the local scan succeeds and finds nothing
// (scanFailed: false, running: false) -- what a split-container scan looks
// like, not an error -- while RCON is connected. Each command must say the
// server IS up, not the old code's confident "Offline"/"not running". The
// scanFailed variant must say "unknown", never a confident offline either.

const getActiveServer = vi.fn(async () => ({ id: "s1", isRemote: true }));
vi.mock("../database/init.js", () => ({ getActiveServer: (...args) => getActiveServer(...args) }));

const fakeBridge = { isModConnected: vi.fn(() => false) };
vi.mock("../services/panelBridge.js", () => ({ default: fakeBridge }));

vi.mock("../services/managedContainer.js", () => ({
  resolveDockerHostSignal: vi.fn(),
  runManagedLifecycle: vi.fn(async () => ({ handled: false })),
}));

const { DiscordBot } = await import("../services/discordBot.js");

function makeInteraction() {
  const replies = [];
  return {
    replies,
    deferReply: async () => {},
    editReply: async (m) => {
      replies.push(typeof m === "string" ? m : m?.embeds?.[0]?.data ?? m);
      return m;
    },
    user: { tag: "someone#0001" },
  };
}

function splitContainerServerManager(overrides = {}) {
  return {
    getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
    getServerStatus: vi.fn(async () => ({
      running: false,
      scanFailed: false,
      uptime: 0,
    })),
    ...overrides,
  };
}

beforeEach(() => {
  getActiveServer.mockClear();
  fakeBridge.isModConnected.mockReset().mockReturnValue(false);
});

describe("Discord commands vs. a split-container deployment (scan clean, RCON connected)", () => {
  it("handleStatus reports Online, not Offline", async () => {
    const bot = Object.create(DiscordBot.prototype);
    bot.serverManager = splitContainerServerManager();
    bot.rconService = { connected: true, getPlayers: async () => ({ success: true, players: [] }) };
    const interaction = makeInteraction();

    await bot.handleStatus(interaction);

    const embedData = interaction.replies.at(-1);
    const statusField = embedData.fields.find((f) => f.name === "Status");
    expect(statusField.value).toMatch(/Online/);
    expect(statusField.value).not.toMatch(/Offline/);
  });

  it("handlePlayers attempts to list players instead of saying the server is offline", async () => {
    const bot = Object.create(DiscordBot.prototype);
    bot.serverManager = splitContainerServerManager();
    bot.rconService = { connected: true, getPlayers: async () => ({ success: true, players: ["alice"] }) };
    const interaction = makeInteraction();

    await bot.handlePlayers(interaction);

    const reply = interaction.replies.at(-1);
    const text = typeof reply === "string" ? reply : JSON.stringify(reply);
    expect(text).not.toMatch(/offline/i);
  });

  it("handleStart refuses with 'already running', not a launch attempt", async () => {
    const bot = Object.create(DiscordBot.prototype);
    bot.serverManager = splitContainerServerManager({
      startServer: vi.fn(async () => ({ success: true })),
    });
    bot.rconService = { connected: true };
    const interaction = makeInteraction();

    await bot.handleStart(interaction);

    expect(interaction.replies[0]).toMatch(/already running/i);
    expect(bot.serverManager.startServer).not.toHaveBeenCalled();
  });

  it("handleStop proceeds (does not refuse with 'not running')", async () => {
    const bot = Object.create(DiscordBot.prototype);
    bot.serverManager = splitContainerServerManager();
    bot.rconService = {
      connected: true,
      save: vi.fn(async () => ({ success: true })),
      quit: vi.fn(async () => ({ success: true })),
    };
    bot.sendNotification = async () => true;
    const interaction = makeInteraction();

    await bot.handleStop(interaction);

    expect(interaction.replies.some((r) => /not running/i.test(r))).toBe(false);
    expect(bot.rconService.save).toHaveBeenCalled();
  });

  it("handleRestart proceeds (does not refuse with 'not running')", async () => {
    const bot = Object.create(DiscordBot.prototype);
    bot.serverManager = splitContainerServerManager();
    bot.rconService = { connected: true };
    bot.scheduler = { performRestart: vi.fn(async () => ({ success: true })) };
    bot.sendNotification = async () => true;
    const interaction = makeInteraction();
    interaction.options = { getInteger: () => 5 };

    await bot.handleRestart(interaction);

    expect(interaction.replies.some((r) => /not running/i.test(r))).toBe(false);
    expect(bot.scheduler.performRestart).toHaveBeenCalled();
  });

  it("updatePlayerPresence shows player info instead of 'Server offline'", async () => {
    const setActivity = vi.fn();
    const bot = Object.create(DiscordBot.prototype);
    bot.isRunning = true;
    bot.client = { user: { setActivity } };
    bot.serverManager = splitContainerServerManager();
    bot.rconService = { connected: true, getPlayers: async () => ({ success: true, players: [] }) };
    bot.getConfiguredMaxPlayers = async () => 16;
    bot._presenceUpdateInFlight = null;

    await bot.updatePlayerPresence();

    expect(setActivity).toHaveBeenCalledWith(expect.not.stringMatching(/offline/i), expect.any(Object));
  });
});

describe("Discord commands vs. a genuinely failed detection scan (scanFailed: true)", () => {
  it("handleStatus reports unknown, not a confident offline", async () => {
    getActiveServer.mockResolvedValue({ id: "s1" });
    const bot = Object.create(DiscordBot.prototype);
    bot.serverManager = splitContainerServerManager({
      getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: true })),
      getServerStatus: vi.fn(async () => ({ running: false, scanFailed: true, uptime: 0 })),
    });
    bot.rconService = { connected: false };
    const interaction = makeInteraction();

    await bot.handleStatus(interaction);

    const embedData = interaction.replies.at(-1);
    const statusField = embedData.fields.find((f) => f.name === "Status");
    expect(statusField.value).toMatch(/Unknown/);
    expect(statusField.value).not.toMatch(/Offline/);
  });

  it("handleStart refuses to guess rather than risking a duplicate launch", async () => {
    getActiveServer.mockResolvedValue({ id: "s1" });
    const bot = Object.create(DiscordBot.prototype);
    bot.serverManager = splitContainerServerManager({
      getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: true })),
      startServer: vi.fn(),
    });
    bot.rconService = { connected: false };
    const interaction = makeInteraction();

    await bot.handleStart(interaction);

    expect(interaction.replies[0]).toMatch(/unable to verify/i);
    expect(bot.serverManager.startServer).not.toHaveBeenCalled();
  });
});
