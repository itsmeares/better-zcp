import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const settings = new Map();
// initDir kept as its OWN stable constant, separate from the mutable tmpDir
// below (ENOTEMPTY class, hunt-wave12, 2026-08-29/30): tmpDir gets
// reassigned by beforeEach, but logger.js's winston singleton resolved
// logsDir from THIS value, once, at the static import a few lines down --
// it never re-reads getDataPaths() afterward. No hook in this file ever
// deletes initDir, which is exactly why it used to leak a real winston
// logger's files forever. See the regression test at the bottom of this
// file.
const initDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-steammigrate-init-"));
let tmpDir = initDir;

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
}));

vi.mock("../utils/paths.js", () => ({
  getDataPaths: () => ({ dataDir: tmpDir, logsDir: tmpDir }),
}));

// ENOTEMPTY class (hunt-wave12, 2026-08-29/30): services/workshopCollectionSync.js
// imports utils/logger.js, so without this the real winston logger resolved
// its logsDir from initDir above (captured at the moment of the static
// import a few lines down) and wrote real log files into it for the
// lifetime of this file's test run. Never the same directory any per-test
// afterEach deletes, so never an ENOTEMPTY risk the way
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

const { getSteamSessionCredentials, setSteamSessionCredentials } =
  await import("../services/workshopCollectionSync.js");
const { readUiSecretFile, writeUiSecretFile } = await import("../utils/uiSecretFile.js");

describe("Steam session cookie pair — migration out of db.json", () => {
  beforeEach(() => {
    settings.clear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-steammigrate-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("nothing configured -> both null", async () => {
    const result = await getSteamSessionCredentials();
    expect(result).toEqual({ sessionId: null, loginSecure: null });
  });

  it("legacy db.json values migrate verbatim into their own files and are cleared from db.json", async () => {
    settings.set("steamSessionId", "legacy-session-id");
    settings.set("steamLoginSecure", "legacy-login-secure-jwt");

    const result = await getSteamSessionCredentials();

    expect(result).toEqual({
      sessionId: "legacy-session-id",
      loginSecure: "legacy-login-secure-jwt",
    });
    expect(settings.get("steamSessionId")).toBeNull();
    expect(settings.get("steamLoginSecure")).toBeNull();
    expect(readUiSecretFile("steamSessionId")).toBe("legacy-session-id");
    expect(readUiSecretFile("steamLoginSecure")).toBe(
      "legacy-login-secure-jwt",
    );
  });

  it("cookies pushed via setSteamSessionCredentials are written to files, not db.json, and read back correctly", async () => {
    await setSteamSessionCredentials("fresh-session-id", "fresh-login-secure");

    expect(settings.get("steamSessionId")).toBeNull();
    expect(settings.get("steamLoginSecure")).toBeNull();

    const result = await getSteamSessionCredentials();
    expect(result).toEqual({
      sessionId: "fresh-session-id",
      loginSecure: "fresh-login-secure",
    });
  });

  it("atomically replaces an existing canonical pair and clears stale database values", async () => {
    writeUiSecretFile("steamSessionId", "old-file-session");
    writeUiSecretFile("steamLoginSecure", "old-file-login");
    settings.set("steamSessionId", "stale-db-session");
    settings.set("steamLoginSecure", "stale-db-login");

    await setSteamSessionCredentials("new-file-session", "new-file-login");

    expect(await getSteamSessionCredentials()).toEqual({
      sessionId: "new-file-session",
      loginSecure: "new-file-login",
    });
    expect(settings.get("steamSessionId")).toBeNull();
    expect(settings.get("steamLoginSecure")).toBeNull();
  });

  it("preserves the canonical counterpart when only one cookie is updated", async () => {
    await setSteamSessionCredentials("initial-session", "initial-login");

    await setSteamSessionCredentials("replacement-session", undefined);

    expect(await getSteamSessionCredentials()).toEqual({
      sessionId: "replacement-session",
      loginSecure: "initial-login",
    });
  });

  it("restores the complete previous pair when the second activation fails", async () => {
    await setSteamSessionCredentials("stable-session", "stable-login");
    const originalRename = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (
        String(source).includes(".tmp-") &&
        String(destination).endsWith("steamLoginSecure.secret")
      ) {
        throw Object.assign(new Error("simulated second-file failure"), { code: "EIO" });
      }
      return originalRename(source, destination);
    });

    const failedWrite = setSteamSessionCredentials(
      "uncommitted-session",
      "uncommitted-login",
    );
    await expect(failedWrite).rejects.toThrow(
      "Could not persist Steam session credentials",
    );
    await expect(failedWrite).rejects.not.toThrow("uncommitted-session");
    await expect(failedWrite).rejects.not.toThrow("uncommitted-login");
    renameSpy.mockRestore();

    expect(await getSteamSessionCredentials()).toEqual({
      sessionId: "stable-session",
      loginSecure: "stable-login",
    });
  });

  it("only one of the pair migrated (asymmetric legacy state) still resolves correctly", async () => {
    settings.set("steamSessionId", "legacy-session-id-only");
    // steamLoginSecure never set — realistic partial-config state.

    const result = await getSteamSessionCredentials();

    expect(result.sessionId).toBe("legacy-session-id-only");
    expect(result.loginSecure).toBeNull();
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
