import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


const settings = new Map();
const initDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-discordadminrole-init-"));
let tmpDir = initDir;

vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
}));

vi.mock("../utils/paths.js", () => ({
  getDataPaths: () => ({ dataDir: tmpDir, logsDir: tmpDir }),
}));

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { DiscordBot } = await import("../services/discordBot.js");

function runningBot() {
  const bot = new DiscordBot(null, null, null, null);
  bot.isRunning = true;
  bot.client = { user: { id: "app1" } };
  bot.registerCommands = vi.fn().mockResolvedValue(undefined);
  return bot;
}

describe("DiscordBot.updateConfig(): adminRoleId normalization matches modRoleId's", () => {
  beforeEach(() => {
    settings.clear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-discordadminrole-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not spuriously re-register commands on a second save when the admin role field stays empty", async () => {
    const bot = runningBot();

    await bot.updateConfig("tok", "guild1", "", "chan1", "");
    bot.registerCommands.mockClear();

    await bot.updateConfig("tok", "guild1", "", "chan1", "");

    expect(bot.registerCommands).not.toHaveBeenCalled();
    expect(bot.adminRoleId).toBeNull();
  });

  it("still re-registers commands when the admin role genuinely changes", async () => {
    const bot = runningBot();

    await bot.updateConfig("tok", "guild1", "", "chan1", "");
    bot.registerCommands.mockClear();

    await bot.updateConfig("tok", "guild1", "role-123", "chan1", "");

    expect(bot.registerCommands).toHaveBeenCalledOnce();
    expect(bot.adminRoleId).toBe("role-123");
  });

  it("still re-registers commands when the admin role is cleared back to empty", async () => {
    const bot = runningBot();

    await bot.updateConfig("tok", "guild1", "role-123", "chan1", "");
    bot.registerCommands.mockClear();

    await bot.updateConfig("tok", "guild1", "", "chan1", "");

    expect(bot.registerCommands).toHaveBeenCalledOnce();
    expect(bot.adminRoleId).toBeNull();
  });
});
