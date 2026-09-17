import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createLocalResetResponse,
  isLocalPanelRequest,
} from "../routes/auth.ts";
import {
  compareDefinitionSets,
  createConflictScanSnapshots,
  extractWorkshopModId,
  filterOwnedClientModIds,
  getModDetailsFromWorkshop,
  groupIntoPairs,
  scoreWorkshopDependencyMatch,
} from "../routes/mods.ts";
import {
  ModChecker,
  getWorkshopAcfCandidates,
  refreshWorkshopChecker,
  minutesToCheckIntervalMs,
  normalizeStoredCheckInterval,
  parseLegacyBoolean,
  parseLegacyMinutes,
} from "../services/modChecker.ts";
import { parseAutoUpdateWarningMinutes } from "../services/updateChecker.ts";
import { BackupService } from "../services/backupService.ts";
import authService from "../services/auth.ts";
import { parsePlayerExportFile } from "../routes/players.ts";
import { requireStoppedForLocalConfigMutation } from "../services/configMutationGuard.ts";

describe("extractWorkshopModId", () => {
  it("rejects a spaced description value instead of truncating it", () => {
    expect(
      extractWorkshopModId(
        "Workshop ID: 3785483068\nMod ID: Kentucky Cellar",
        "Kentucky Cellar",
      ),
    ).toBeNull();
  });

  it("accepts a clean Mod ID from the description", () => {
    expect(
      extractWorkshopModId("Mod ID: KentuckyCellar", "Kentucky Cellar"),
    ).toBe("KentuckyCellar");
  });

  it("accepts a clean title as the final fallback", () => {
    expect(extractWorkshopModId("No mod ID listed", "KentuckyCellar")).toBe(
      "KentuckyCellar",
    );
  });
});
describe("Restart timeout pattern", () => {
  it("should not leave dangling rejections when operation wins the race", async () => {
    vi.useFakeTimers();
    try {
      let timeoutId;
      let timeoutSettled = false;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Timeout")), 5000);
      });
      timeoutPromise.catch(() => {
        timeoutSettled = true;
      });

      const operationPromise = Promise.resolve("done");

      const result = await Promise.race([operationPromise, timeoutPromise]);
      clearTimeout(timeoutId);

      expect(result).toBe("done");

      await vi.advanceTimersByTimeAsync(5000);

      expect(timeoutSettled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should reject when operation takes too long", async () => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Timeout")), 10);
    });

    const slowOperation = new Promise((resolve) => setTimeout(resolve, 5000));

    try {
      await Promise.race([slowOperation, timeoutPromise]);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e.message).toBe("Timeout");
    }
    clearTimeout(timeoutId);
  });

  it("sendWarning helper should catch both success and timeout", async () => {
    const sendWarning = async (msg, shouldSucceed = true) => {
      try {
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("RCON timeout")), 50);
        });
        const operation = shouldSucceed
          ? Promise.resolve("sent")
          : new Promise((resolve) => setTimeout(resolve, 5000));
        await Promise.race([operation, timeoutPromise]);
        clearTimeout(timeoutId);
        return "ok";
      } catch (e) {
        return e.message;
      }
    };

    expect(await sendWarning("test", true)).toBe("ok");

    expect(await sendWarning("test", false)).toBe("RCON timeout");
  });
});

describe("automatic update warning parsing", () => {
  it("uses the documented default for unset or blank settings", () => {
    expect(parseAutoUpdateWarningMinutes(null)).toBe(15);
    expect(parseAutoUpdateWarningMinutes(undefined)).toBe(15);
    expect(parseAutoUpdateWarningMinutes(" ")).toBe(15);
  });

  it("keeps valid values bounded and rejects invalid values", () => {
    expect(parseAutoUpdateWarningMinutes("5")).toBe(5);
    expect(parseAutoUpdateWarningMinutes(2.9)).toBe(2);
    expect(parseAutoUpdateWarningMinutes(-4)).toBe(0);
    expect(parseAutoUpdateWarningMinutes(90)).toBe(60);
    expect(parseAutoUpdateWarningMinutes("abc")).toBe(15);
  });
});

describe("modChecker interval error handling", () => {
  it("should catch errors in async interval callback", async () => {
    let errorCaught = false;
    let intervalCleared = false;
    let callCount = 0;

    const intervalCallback = async () => {
      try {
        callCount++;
        throw new Error("RCON connection failed");
      } catch (error) {
        errorCaught = true;
        intervalCleared = true;
      }
    };

    await intervalCallback();

    expect(errorCaught).toBe(true);
    expect(intervalCleared).toBe(true);
    expect(callCount).toBe(1);
  });
});

describe("mod checker interval normalization", () => {
  it("stores Settings values as whole minutes instead of treating them as milliseconds", () => {
    expect(minutesToCheckIntervalMs("30")).toBe(1_800_000);
    expect(normalizeStoredCheckInterval("30")).toEqual({
      intervalMs: 1_800_000,
      minutes: 30,
      legacy: false,
    });
  });

  it("migrates legacy whole-minute millisecond values", () => {
    expect(normalizeStoredCheckInterval(300_000)).toEqual({
      intervalMs: 300_000,
      minutes: 5,
      legacy: true,
    });
  });

  it("rejects fractional, out-of-range, and malformed values", () => {
    expect(minutesToCheckIntervalMs("1.5")).toBeNull();
    expect(minutesToCheckIntervalMs(0)).toBeNull();
    expect(minutesToCheckIntervalMs(121)).toBeNull();
    expect(normalizeStoredCheckInterval("not-a-number")).toBeNull();
  });
});

describe("local password reset hardening", () => {
  it("does not include reset token values in local reset responses", () => {
    const response = createLocalResetResponse(
      "Recovery token created at data/reset-token.txt. Paste it below to continue.",
    );

    expect(response).toEqual({
      success: true,
      resetAvailable: true,
      message:
        "Recovery token created at data/reset-token.txt. Paste it below to continue.",
    });
    expect(response).not.toHaveProperty("token");
  });

  it("does not trust proxy-derived IP fields for local-only reset detection", () => {
    const spoofedRequest = {
      ip: "127.0.0.1",
      ips: ["127.0.0.1"],
      socket: { remoteAddress: "8.8.8.8" },
      connection: { remoteAddress: "8.8.8.8" },
    };

    expect(isLocalPanelRequest(spoofedRequest)).toBe(false);
  });

  it("accepts real loopback socket addresses for local reset detection", () => {
    const localRequest = {
      socket: { remoteAddress: "::ffff:127.0.0.1" },
      connection: { remoteAddress: "::ffff:127.0.0.1" },
    };

    expect(isLocalPanelRequest(localRequest)).toBe(true);
  });
});

describe("logout and export trust boundaries", () => {
  it("rejects forged refresh tokens even when the payload matches a real session", async () => {
    const dbModule = await import("../database/init.ts");
    const getDbSpy = vi.spyOn(dbModule, "getDb").mockResolvedValue({
      data: {
        users: [
          {
            id: "user-1",
            username: "admin",
            role: "admin",
            tokenGen: 0,
            refreshSessions: [{ id: "real-session", expiresAt: new Date(Date.now() + 60_000).toISOString() }],
          },
        ],
      },
    });

    authService.jwtSecret = "test-secret";
    const forgedRefreshToken =
      "eyJhbGciOiJub25lIn0.eyJ1c2VySWQiOiJ1c2VyLTEiLCJ0eXBlIjoicmVmcmVzaCIsInRva2VuR2VuIjowLCJzZXNzaW9uSWQiOiJyZWFsLXNlc3Npb24ifQ.";

    await expect(authService.logout(forgedRefreshToken)).resolves.toBe(false);
    getDbSpy.mockRestore();
  });

  it("rejects oversized or non-object export payloads before parsing JSON", () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "zcp-export-"),
    );

    try {
      const largeTempPath = path.join(temporaryDirectory, "too-large.json");
      fs.writeFileSync(
        largeTempPath,
        JSON.stringify({ payload: "x".repeat(6 * 1024 * 1024) }),
      );

      expect(() => parsePlayerExportFile(largeTempPath)).toThrow(/too large/i);

      const invalidTempPath = path.join(temporaryDirectory, "invalid.json");
      fs.writeFileSync(invalidTempPath, "not-json");

      expect(() => parsePlayerExportFile(invalidTempPath)).toThrow(
        /invalid json/i,
      );
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("config mutation guard", () => {
  it("fails closed when server state cannot be verified", async () => {
    const dbModule = await import("../database/init.ts");
    const getActiveServerSpy = vi
      .spyOn(dbModule, "getActiveServer")
      .mockResolvedValue(null);

    try {
      const next = vi.fn();
      const req = { app: { get: vi.fn() } };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await requireStoppedForLocalConfigMutation(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
      );
    } finally {
      getActiveServerSpy.mockRestore();
    }
  });

  it("lets a remote server's config mutation through without probing local process state", async () => {
    const dbModule = await import("../database/init.ts");
    const getActiveServerSpy = vi
      .spyOn(dbModule, "getActiveServer")
      .mockResolvedValue({ isRemote: true });

    try {
      const next = vi.fn();
      const appGet = vi.fn();
      const req = { app: { get: appGet } };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await requireStoppedForLocalConfigMutation(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(appGet).not.toHaveBeenCalled();
    } finally {
      getActiveServerSpy.mockRestore();
    }
  });

  it("treats a configured-but-unreachable local path as unverifiable, not as remote", async () => {
    const missingPath = path.join(os.tmpdir(), "zcp-guard-test-missing-path-does-not-exist");
    expect(fs.existsSync(missingPath)).toBe(false);

    const dbModule = await import("../database/init.ts");
    const getActiveServerSpy = vi.spyOn(dbModule, "getActiveServer").mockResolvedValue({
      installPath: missingPath,
      isRemote: true, // what normalizeServerMemory would actually compute here
    });

    try {
      const next = vi.fn();
      const appGet = vi.fn();
      const req = { app: { get: appGet } };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await requireStoppedForLocalConfigMutation(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(appGet).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
      );
    } finally {
      getActiveServerSpy.mockRestore();
    }
  });
});

describe("mod update auto-restart dedupe", () => {
  it("marks offline mod updates as handled instead of retrying every poll", async () => {
    const checker = new ModChecker();
    checker.scheduler = { rconService: { connected: false } };
    checker.serverManager = {
      getServerProcessDetails: vi
        .fn()
        .mockResolvedValue({ running: false, scanFailed: false }),
    };

    const result = await checker.triggerModRestart([
      { workshopId: "2503622437", name: "Skill Recovery Journal" },
    ]);

    expect(result).toMatchObject({
      success: true,
      skipped: true,
      markProcessed: true,
      reason: "server_offline",
    });
    expect(checker.pendingRestart).toBe(false);
  });

  it("keeps retrying when the server is running but RCON is disconnected", async () => {
    const checker = new ModChecker();
    checker.scheduler = { rconService: { connected: false } };
    checker.serverManager = {
      getServerProcessDetails: vi
        .fn()
        .mockResolvedValue({ running: true, scanFailed: false }),
    };

    const result = await checker.triggerModRestart([
      { workshopId: "3437629766", name: "CleanUI [B42.12]" },
    ]);

    expect(result).toMatchObject({
      success: false,
      retry: true,
      reason: "rcon_disconnected",
    });
    expect(checker.pendingRestart).toBe(false);
  });

  it("retries instead of marking processed when detection can't confirm the server is offline", async () => {
    const checker = new ModChecker();
    checker.scheduler = { rconService: { connected: false } };
    checker.serverManager = {
      getServerProcessDetails: vi
        .fn()
        .mockResolvedValue({ running: false, scanFailed: true }),
    };

    const result = await checker.triggerModRestart([
      { workshopId: "1111111111", name: "Some Mod" },
    ]);

    expect(result).toMatchObject({
      success: false,
      retry: true,
      reason: "rcon_disconnected",
    });
    expect(checker.pendingRestart).toBe(false);
  });
});

describe("mod removal ownership filtering", () => {
  it("only accepts client-provided mod IDs verified against the workshop item", () => {
    const filtered = filterOwnedClientModIds(
      [
        "OwnedMod",
        "UnrelatedMod",
        "1234567890",
        "OwnedMod",
        "Bad;Entry",
        "OtherOwned",
      ],
      ["OwnedMod", "OtherOwned"],
    );

    expect(filtered).toEqual(["OwnedMod", "OtherOwned"]);
  });

  it("rejects all client-provided IDs when the server cannot verify ownership", () => {
    expect(filterOwnedClientModIds(["LooksLegit"], [])).toEqual([]);
  });
});

describe("mod name resolution from disk", () => {
  it("prefers the newest versioned mod.info over legacy manifests", async () => {
    const tempRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "zcp-mod-name-"),
    );
    try {
      const workshopId = "3490188370";
      const workshopRoot = path.join(tempRoot, "steamapps", "workshop");
      const modRoot = path.join(
        workshopRoot,
        "content",
        "108600",
        workshopId,
        "mods",
        "Project_Cook",
      );

      await fs.promises.mkdir(path.join(modRoot, "42"), { recursive: true });
      await fs.promises.mkdir(path.join(modRoot, "42.15"), { recursive: true });
      await fs.promises.writeFile(
        path.join(modRoot, "42", "mod.info"),
        "name=Project Cook [Legacy]\nid=Project_Cook\n",
      );
      await fs.promises.writeFile(
        path.join(modRoot, "42.15", "mod.info"),
        "name=Project Cook\nid=Project_Cook\n",
      );

      const checker = new ModChecker();
      checker.workshopAcfPath = path.join(
        workshopRoot,
        "appworkshop_108600.acf",
      );

      expect(checker.resolveModNameFromDisk(workshopId, true)).toBe(
        "Project Cook",
      );
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses newest versioned mod.info metadata for current-config details", async () => {
    const tempRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "zcp-mod-details-"),
    );
    try {
      const workshopId = "3490188370";
      const modRoot = path.join(
        tempRoot,
        "steamapps",
        "workshop",
        "content",
        "108600",
        workshopId,
        "mods",
        "Project_Cook",
      );

      await fs.promises.mkdir(path.join(modRoot, "42"), { recursive: true });
      await fs.promises.mkdir(path.join(modRoot, "42.15"), { recursive: true });
      await fs.promises.writeFile(
        path.join(modRoot, "42", "mod.info"),
        "name=Project Cook [Legacy]\nid=Project_Cook\n",
      );
      await fs.promises.writeFile(
        path.join(modRoot, "42.15", "mod.info"),
        "name=Project Cook\nid=Project_Cook\n",
      );

      expect(getModDetailsFromWorkshop(workshopId, tempRoot)).toEqual([
        expect.objectContaining({ id: "Project_Cook", name: "Project Cook" }),
      ]);
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("workshop ACF candidate discovery", () => {
  it("walks up from a nested startup script to the SteamCMD workshop path", () => {
    const installScript = path.join(
      "C:\\PZServer",
      "steamapps",
      "common",
      "ProjectZomboid",
      "StartServer64.bat",
    );

    expect(getWorkshopAcfCandidates(installScript)).toContain(
      path.join("C:\\PZServer", "steamapps", "workshop", "appworkshop_108600.acf"),
    );
  });

  it("returns no candidates when no install path is available", () => {
    expect(getWorkshopAcfCandidates(" ")).toEqual([]);
  });
});

describe("workshop checker lifecycle", () => {
  it("starts polling when an ACF path becomes available", async () => {
    const modChecker = {
      findWorkshopAcfPath: vi.fn().mockResolvedValue("/pz/steamapps/workshop/appworkshop_108600.acf"),
      isRunning: false,
      start: vi.fn(),
      stop: vi.fn(),
    };

    await expect(refreshWorkshopChecker(modChecker)).resolves.toContain("appworkshop_108600.acf");
    expect(modChecker.start).toHaveBeenCalledOnce();
    expect(modChecker.stop).not.toHaveBeenCalled();
  });

  it("stops polling when the ACF path disappears", async () => {
    const modChecker = {
      findWorkshopAcfPath: vi.fn().mockResolvedValue(null),
      isRunning: true,
      start: vi.fn(),
      stop: vi.fn(),
    };

    await expect(refreshWorkshopChecker(modChecker)).resolves.toBeNull();
    expect(modChecker.start).not.toHaveBeenCalled();
    expect(modChecker.stop).toHaveBeenCalledOnce();
  });
});

describe("workshop dependency search ranking", () => {
  it("ranks exact internal mod ID matches above variants that only contain the query", () => {
    const exact = scoreWorkshopDependencyMatch(
      "TombBody",
      "TombBody",
      "Tomb's Player Body",
    );
    const texture = scoreWorkshopDependencyMatch(
      "TombBody",
      "TombBodyTex",
      "Tomb's Player Body - Textures",
    );
    const custom = scoreWorkshopDependencyMatch(
      "TombBody",
      "TombBodyCustom",
      "Tomb's Player Body - Customisation",
    );

    expect(exact.matchType).toBe("exact-id");
    expect(exact.score).toBeGreaterThan(texture.score);
    expect(exact.score).toBeGreaterThan(custom.score);
  });
});

describe("conflict pair grouping", () => {
  function conflict(mods, severity = "high") {
    return {
      file: "media/lua/shared/Foo.lua",
      category: "lua-shared",
      categoryLabel: "Lua",
      severity,
      mods: mods.map((modId) => ({ modId, modName: modId, workshopId: "1" })),
    };
  }

  it("never pairs a mod with itself when it ships the same path twice", () => {
    const { pairs, truncated } = groupIntoPairs([
      conflict(["ModA", "ModA", "ModB"]),
    ]);

    expect(truncated).toBe(false);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].modA.modId).toBe("ModA");
    expect(pairs[0].modB.modId).toBe("ModB");
    expect(pairs[0].files).toHaveLength(1);
    expect(pairs[0].highCount).toBe(1);
  });

  it("counts each real pair once per conflicting file", () => {
    const { pairs, truncated } = groupIntoPairs([
      conflict(["ModA", "ModB"]),
      conflict(["ModA", "ModB"], "medium"),
    ]);

    expect(truncated).toBe(false);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].highCount).toBe(1);
    expect(pairs[0].mediumCount).toBe(1);
  });

  it("caps the pair-file projection across high-fanout conflicts", () => {
    const modIds = Array.from({ length: 20 }, (_, i) => `Mod${i}`);
    const maxFileEntries = 50;

    const { pairs, truncated, groupedFileEntries } = groupIntoPairs(
      [conflict(modIds), conflict(modIds, "medium")],
      maxFileEntries,
    );

    expect(truncated).toBe(true);
    expect(groupedFileEntries).toBe(maxFileEntries);
    expect(
      pairs.reduce((total, pair) => total + pair.files.length, 0),
    ).toBe(maxFileEntries);
  });
});

describe("conflict scan snapshots", () => {
  it("normalizes Workshop order but preserves Mods= load order", () => {
    expect(createConflictScanSnapshots(["2", "1"], ["ModB", "ModA"]))
      .toEqual({ workshop: "1,2", mods: "ModB,ModA" });
    expect(createConflictScanSnapshots(["1", "2"], ["ModA", "ModB"]).mods)
      .not.toBe("ModB,ModA");
  });
});

describe("shared definition comparison", () => {
  const entries = [
    { modId: "ModA", absPath: "/a" },
    { modId: "ModB", absPath: "/b" },
  ];

  it("treats a file that parsed to zero definitions as additive, not conflicting", () => {
    const result = compareDefinitionSets(entries, (p) =>
      p === "/a" ? new Set() : new Set(["Base.item.Axe"]),
    );

    expect(result.disjoint).toBe(true);
    expect(result.inconclusive).toBe(false);
  });

  it("fails closed when a file could not be parsed at all", () => {
    const result = compareDefinitionSets(entries, (p) =>
      p === "/a" ? null : new Set(["Base.item.Axe"]),
    );

    expect(result.disjoint).toBe(false);
    expect(result.inconclusive).toBe(true);
  });

  it("reports the names that actually collide", () => {
    const result = compareDefinitionSets(entries, () =>
      new Set(["Base.item.Axe", "Base.item.Bat"]),
    );

    expect(result.disjoint).toBe(false);
    expect(result.overlapping.sort()).toEqual([
      "Base.item.Axe",
      "Base.item.Bat",
    ]);
  });

  it("ignores collisions between two copies belonging to the same mod", () => {
    const sameMod = [
      { modId: "ModA", absPath: "/a" },
      { modId: "ModA", absPath: "/a42" },
    ];
    const result = compareDefinitionSets(sameMod, () =>
      new Set(["Base.item.Axe"]),
    );

    expect(result.overlapping).toEqual([]);
    expect(result.inconclusive).toBe(true);
  });
});

describe("legacy mod auto-restart settings migration", () => {
  it("migrates a real boolean, as written by Settings", () => {
    expect(parseLegacyBoolean(true)).toBe(true);
    expect(parseLegacyBoolean(false)).toBe(false);
  });

  it("migrates string booleans", () => {
    expect(parseLegacyBoolean("true")).toBe(true);
    expect(parseLegacyBoolean(" On ")).toBe(true);
    expect(parseLegacyBoolean("0")).toBe(false);
  });

  it("reports an unset or unrecognised value instead of guessing", () => {
    expect(parseLegacyBoolean(null)).toBeNull();
    expect(parseLegacyBoolean("maybe")).toBeNull();
  });

  it("migrates the warning delay stored as a string", () => {
    expect(parseLegacyMinutes("5")).toBe(5);
    expect(parseLegacyMinutes(0)).toBe(0);
  });

  it("does not turn an unset delay into a zero-minute countdown", () => {
    expect(parseLegacyMinutes(null)).toBeNull();
    expect(parseLegacyMinutes("")).toBeNull();
    expect(parseLegacyMinutes("abc")).toBeNull();
  });
});

describe("online player count when RCON is unavailable", () => {
  const withRcon = (rconService) => {
    const checker = new ModChecker();
    checker.scheduler = rconService ? { rconService } : null;
    return checker;
  };

  it("counts players when RCON answers", async () => {
    const checker = withRcon({
      getPlayers: async () => ({ success: true, players: ["a", "b"] }),
    });
    await expect(checker.getOnlinePlayerCount()).resolves.toBe(2);
  });

  it("reports unknown rather than empty when RCON throws", async () => {
    const checker = withRcon({
      getPlayers: async () => {
        throw new Error("connection reset");
      },
    });
    await expect(checker.getOnlinePlayerCount()).resolves.toBeNull();
  });

  it("reports unknown rather than empty when RCON fails softly", async () => {
    const checker = withRcon({
      getPlayers: async () => ({ success: false }),
    });
    await expect(checker.getOnlinePlayerCount()).resolves.toBeNull();
  });

  it("reports unknown when there is no RCON service at all", async () => {
    await expect(withRcon(null).getOnlinePlayerCount()).resolves.toBeNull();
  });
});

describe("backup restore guards against a running server", () => {
  it("refuses to restore while the server is running", async () => {
    const service = new BackupService();
    service.setServerManager({
      getServerProcessDetails: async () => ({ running: true, scanFailed: false }),
    });

    const result = await service.restoreBackup("world.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/still running/i);
    expect(service.restoreInProgress).toBe(false);
  });

  it("refuses to restore when the running state cannot be confirmed", async () => {
    const service = new BackupService();
    service.setServerManager({
      checkServerRunning: async () => {
        throw new Error("ps failed");
      },
    });

    const result = await service.restoreBackup("world.zip");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/could not confirm/i);
  });
});

describe("Remote server config over SFTP", () => {
  const load = () => import("../services/remoteConfigFiles.ts");

  it("refuses a remote folder that is relative or escapes upward", async () => {
    const { validateRemoteConfigTransport } = await load();
    const base = { host: "h", port: 22, username: "u", password: "p" };
    expect(() =>
      validateRemoteConfigTransport({ ...base, configPath: "Zomboid/Server" }),
    ).toThrow(/absolute POSIX path/);
    expect(() =>
      validateRemoteConfigTransport({ ...base, configPath: "/srv/../etc" }),
    ).toThrow(/absolute POSIX path/);
    expect(() =>
      validateRemoteConfigTransport({ ...base, configPath: "" }),
    ).toThrow(/config folder is required/);
    expect(
      validateRemoteConfigTransport({ ...base, configPath: "/srv/pz/Server/" })
        .configPath,
    ).toBe("/srv/pz/Server");
  });

  it("only ever names the four config files the editor touches", async () => {
    const { mirroredFileNames } = await load();
    expect(mirroredFileNames("DoomerZ")).toEqual([
      "DoomerZ.ini",
      "DoomerZ_SandboxVars.lua",
      "DoomerZ_spawnpoints.lua",
      "DoomerZ_spawnregions.lua",
    ]);
    expect(() => mirroredFileNames("../../etc/passwd")).toThrow();
    expect(() => mirroredFileNames("")).toThrow();
  });

  it("treats the mirror as configured only when host and folder are both set", async () => {
    const { isRemoteConfigConfigured } = await load();
    expect(isRemoteConfigConfigured({})).toBe(false);
    expect(isRemoteConfigConfigured({ panelBridgeSftpHost: "h" })).toBe(false);
    expect(
      isRemoteConfigConfigured({ panelBridgeSftpConfigPath: "/srv" }),
    ).toBe(false);
    expect(
      isRemoteConfigConfigured({
        panelBridgeSftpHost: "h",
        panelBridgeSftpConfigPath: "/srv",
      }),
    ).toBe(true);
  });

  it("serializes overlapping requests so one pull cannot clobber another edit", async () => {
    const { acquireMirrorLock } = await load();
    const order = [];
    const first = acquireMirrorLock().then(async (release) => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("a-end");
      release();
    });
    const second = acquireMirrorLock().then((release) => {
      order.push("b-start");
      release();
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });
});
