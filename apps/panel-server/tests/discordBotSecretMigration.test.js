import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const settings = new Map();
// Seeded immediately, not inside beforeEach — discordBot.js's static
// imports run at module-load time, before any hook fires (same timing
// lesson as jwtSecretMigration.test.js).
//
// initDir is kept as its OWN stable constant, separate from the mutable
// tmpDir below (ENOTEMPTY class, hunt-wave12, 2026-08-29/30): tmpDir gets
// reassigned by beforeEach, but logger.js's winston singleton resolved
// logsDir from THIS value, once, at the import a few lines down -- it
// never re-reads getDataPaths() afterward. No hook in this file ever
// deletes initDir, which is exactly why it used to leak a real winston
// logger's files forever (measured on this machine: 660 such directories
// from this file's prefix, every sampled one containing real
// combined.log/error.log). See the regression test at the bottom of this
// file.
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

// ENOTEMPTY class (hunt-wave12, 2026-08-29/30): services/discordBot.js
// imports utils/logger.js, so without this the real winston logger
// resolved its logsDir from initDir above and wrote real log files into it
// for the lifetime of this file's test run. Never the same directory any
// per-test afterEach deletes, so never an ENOTEMPTY risk the way
// modThumbnailResolution.test.js's race was (5d5a9088) -- but a real,
// separate, measured leak this mock closes. Matches the convention already
// established elsewhere in this suite.
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

    expect(settings.get("discordBotToken")).toBeUndefined(); // never touched db.json
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

// ENOTEMPTY class regression (hunt-wave12, 2026-08-29/30): placed last so
// every test above has already run. Before the logger.js mock above, this
// failed -- initDir genuinely contained combined.log/error.log, measured
// directly on this machine. After it, nothing ever writes into initDir at
// all, so this stays green rather than decorative.
describe("ENOTEMPTY class regression: the module-load-time seed directory never receives real logger writes", () => {
  it("initDir (captured at the static import above, never deleted by any hook) contains no *.log files", () => {
    expect(
      fs.readdirSync(initDir).filter((f) => f.endsWith(".log")),
    ).toEqual([]);
  });
});
