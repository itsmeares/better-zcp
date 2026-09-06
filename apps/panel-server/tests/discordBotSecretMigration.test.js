import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const settings = new Map();
const initDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-discordmigrate-init-"));
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
const { readUiSecretFile } = await import("../utils/uiSecretFile.js");

describe("DiscordBot config — discordBotToken migration out of db.json", () => {
  beforeEach(() => {
    settings.clear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-discordmigrate-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("no legacy value, no file -> loadConfig leaves the token unset", async () => {
    const bot = new DiscordBot(null, null, null, null);
    await bot.loadConfig();
    expect(bot.token).toBeNull();
  });

  it("a legacy db.json token migrates verbatim into its own file and is cleared from db.json", async () => {
    settings.set("discordBotToken", "legacy-bot-token-abc");
    const bot = new DiscordBot(null, null, null, null);

    await bot.loadConfig();

    expect(bot.token).toBe("legacy-bot-token-abc");
    expect(settings.get("discordBotToken")).toBeNull();
    expect(readUiSecretFile("discordBotToken")).toBe("legacy-bot-token-abc");
  });

  it("a token saved via updateConfig() is written to the file, not db.json, and is loaded back correctly on a fresh instance (restart)", async () => {
    const bot = new DiscordBot(null, null, null, null);
    await bot.updateConfig("new-real-token", null, null, null, null);

    expect(settings.get("discordBotToken")).toBeUndefined();
    expect(readUiSecretFile("discordBotToken")).toBe("new-real-token");

    const restarted = new DiscordBot(null, null, null, null);
    await restarted.loadConfig();
    expect(restarted.token).toBe("new-real-token");
  });

  it("resetConfig() clears the token file, not just db.json", async () => {
    const bot = new DiscordBot(null, null, null, null);
    await bot.updateConfig("token-to-be-cleared", null, null, null, null);
    expect(readUiSecretFile("discordBotToken")).toBe("token-to-be-cleared");

    await bot.resetConfig();

    expect(readUiSecretFile("discordBotToken")).toBeNull();
    expect(bot.token).toBeNull();
  });
});

describe("ENOTEMPTY class regression: the module-load-time seed directory never receives real logger writes", () => {
  it("initDir (captured at the static import above, never deleted by any hook) contains no *.log files", () => {
    expect(
      fs.readdirSync(initDir).filter((f) => f.endsWith(".log")),
    ).toEqual([]);
  });
});
