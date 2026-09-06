import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Same "declare before vi.mock, mutate in beforeEach" pattern as
// jwtSecret.test.js — the factory doesn't run until first import, by which
// point tmpDir already has a value.
let tmpDir;

vi.mock("../utils/paths.js", () => ({
  getDataPaths: () => ({ dataDir: tmpDir }),
}));

const { readUiSecretFile, writeUiSecretFile, loadUiSecret } = await import(
  "../utils/uiSecretFile.js"
);

describe("readUiSecretFile / writeUiSecretFile", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-uisecret-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the file does not exist", () => {
    expect(readUiSecretFile("discordBotToken")).toBeNull();
  });

  it("writes then reads back the same value", () => {
    writeUiSecretFile("discordBotToken", "a-real-bot-token");
    expect(readUiSecretFile("discordBotToken")).toBe("a-real-bot-token");
  });

  it("writing an empty/null value removes the file instead of leaving an empty one", () => {
    writeUiSecretFile("discordBotToken", "something");
    expect(fs.existsSync(path.join(tmpDir, "discordBotToken.secret"))).toBe(
      true,
    );
    writeUiSecretFile("discordBotToken", "");
    expect(fs.existsSync(path.join(tmpDir, "discordBotToken.secret"))).toBe(
      false,
    );
    expect(readUiSecretFile("discordBotToken")).toBeNull();
  });

  it("does NOT crash on an unreadable file (a directory at the path) — proportionate, not fail-loud like jwt.secret", () => {
    const filePath = path.join(tmpDir, "discordBotToken.secret");
    fs.mkdirSync(filePath);
    const log = { warn: vi.fn() };
    expect(readUiSecretFile("discordBotToken", log)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("not configured"),
    );
  });
});

describe("loadUiSecret — migration from a legacy db.json value", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-uisecret-migrate-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("no file, no legacy value -> returns null, writes nothing", async () => {
    const result = await loadUiSecret("discordBotToken", {
      legacyValue: null,
    });
    expect(result).toBeNull();
    expect(
      fs.existsSync(path.join(tmpDir, "discordBotToken.secret")),
    ).toBe(false);
  });

  it("no file, a legacy value exists -> migrates verbatim and clears the legacy value", async () => {
    const clearLegacy = vi.fn().mockResolvedValue(undefined);
    const result = await loadUiSecret("discordBotToken", {
      legacyValue: "legacy-token-from-db-json",
      clearLegacy,
    });
    expect(result).toBe("legacy-token-from-db-json");
    expect(readUiSecretFile("discordBotToken")).toBe(
      "legacy-token-from-db-json",
    );
    expect(clearLegacy).toHaveBeenCalledTimes(1);
  });

  it("file already exists -> loads it and ignores any legacy value passed in (steady-state restart)", async () => {
    writeUiSecretFile("discordBotToken", "current-file-value");
    const clearLegacy = vi.fn();
    const result = await loadUiSecret("discordBotToken", {
      legacyValue: "stale-legacy-value",
      clearLegacy,
    });
    expect(result).toBe("current-file-value");
    expect(clearLegacy).not.toHaveBeenCalled();
  });

  it("a migration-write failure (directory at the path) falls back to the legacy value for this run instead of crashing or losing it", async () => {
    const filePath = path.join(tmpDir, "discordBotToken.secret");
    fs.mkdirSync(filePath); // writeFileSync to this path throws EISDIR
    const clearLegacy = vi.fn();
    const log = { warn: vi.fn() };
    const result = await loadUiSecret("discordBotToken", {
      legacyValue: "legacy-value",
      clearLegacy,
      log,
    });
    expect(result).toBe("legacy-value");
    expect(clearLegacy).not.toHaveBeenCalled(); // never cleared what wasn't safely moved
    expect(log.warn).toHaveBeenCalled();
  });
});
