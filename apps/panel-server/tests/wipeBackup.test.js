import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(),
  getActiveServer: vi.fn(),
}));

vi.mock("../routes/chunks.ts", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { default: router } = await import("../routes/server.js");

const SERVER_NAME = "servertest";

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getWipeHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/wipe" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

let root;
let savePath;
let saveDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-wipe-backup-"));
  savePath = root;
  saveDir = path.join(savePath, "Saves", "Multiplayer", SERVER_NAME);
  fs.mkdirSync(path.join(saveDir, "map"), { recursive: true });
  fs.writeFileSync(path.join(saveDir, "map", "0_0.bin"), "chunk");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function buildServerManager() {
  return {
    loadConfig: async () => {},
    getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
    savePath,
    serverName: SERVER_NAME,
  };
}

describe("POST /api/server/wipe backs up before deleting (default createBackup: true)", () => {
  it("aborts the wipe and deletes nothing when the backup fails", async () => {
    const serverManager = buildServerManager();
    const backupService = {
      createBackup: vi.fn(async () => ({ success: false, message: "disk full" })),
    };
    const app = {
      get: (key) => {
        if (key === "serverManager") return serverManager;
        if (key === "backupService") return backupService;
        return undefined;
      },
    };

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(
      { app, body: { targets: ["map"], confirm: true } },
      response,
    );

    expect(backupService.createBackup).toHaveBeenCalledTimes(1);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "WIPE_BACKUP_FAILED" }),
    );
    expect(fs.existsSync(path.join(saveDir, "map", "0_0.bin"))).toBe(true);
  });

  it("aborts the wipe and deletes nothing when the pre-wipe backup completed but silently skipped a file", async () => {
    const serverManager = buildServerManager();
    const backupService = {
      createBackup: vi.fn(async () => ({
        success: true,
        backup: { name: "servertest_2026.zip" },
        skippedFiles: ["servertest/map/0_0.bin"],
      })),
    };
    const app = {
      get: (key) => {
        if (key === "serverManager") return serverManager;
        if (key === "backupService") return backupService;
        return undefined;
      },
    };

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(
      { app, body: { targets: ["map"], confirm: true } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "WIPE_BACKUP_FAILED" }),
    );
    expect(fs.existsSync(path.join(saveDir, "map", "0_0.bin"))).toBe(true);
  });

  it("aborts the wipe and deletes nothing when no backup service is registered", async () => {
    const serverManager = buildServerManager();
    const app = {
      get: (key) => (key === "serverManager" ? serverManager : undefined),
    };

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(
      { app, body: { targets: ["map"], confirm: true } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "WIPE_BACKUP_FAILED" }),
    );
    expect(fs.existsSync(path.join(saveDir, "map", "0_0.bin"))).toBe(true);
  });

  it("backs up first, then deletes, and reports the backup in the response when it succeeds", async () => {
    const serverManager = buildServerManager();
    const backupService = {
      createBackup: vi.fn(async () => ({
        success: true,
        backup: { name: "servertest_2026.zip" },
      })),
    };
    const app = {
      get: (key) => {
        if (key === "serverManager") return serverManager;
        if (key === "backupService") return backupService;
        return undefined;
      },
    };

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(
      { app, body: { targets: ["map"], confirm: true } },
      response,
    );

    expect(backupService.createBackup).toHaveBeenCalledTimes(1);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        backupCreated: true,
        backupName: "servertest_2026.zip",
      }),
    );
    expect(fs.existsSync(path.join(saveDir, "map"))).toBe(false);
  });

  it("copies the accounts database alongside the save backup when 'accounts' is selected", async () => {
    const dbDir = path.join(savePath, "db");
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, `${SERVER_NAME}.db`), "whitelist");

    const backupsDir = path.join(root, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });

    const serverManager = buildServerManager();
    const backupService = {
      createBackup: vi.fn(async () => ({
        success: true,
        backup: { name: "servertest_2026.zip" },
      })),
      getBackupsPath: vi.fn(async () => backupsDir),
    };
    const app = {
      get: (key) => {
        if (key === "serverManager") return serverManager;
        if (key === "backupService") return backupService;
        return undefined;
      },
    };

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(
      { app, body: { targets: ["accounts"], confirm: true } },
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, backupCreated: true }),
    );
    expect(fs.existsSync(path.join(dbDir, `${SERVER_NAME}.db`))).toBe(false);
    const copied = fs
      .readdirSync(backupsDir)
      .filter((name) => name.includes("_accounts_"));
    expect(copied.length).toBe(1);
    expect(
      fs.existsSync(path.join(backupsDir, copied[0], `${SERVER_NAME}.db`)),
    ).toBe(true);
  });
});

describe("POST /api/server/wipe reports partial state when a deletion step throws mid-way", () => {
  it("surfaces WIPE_PARTIAL_FAILURE with the partial results and backup info instead of a bare {error}", async () => {
    const serverManager = buildServerManager();
    const backupService = {
      createBackup: vi.fn(async () => ({
        success: true,
        backup: { name: "servertest_2026.zip" },
      })),
    };
    const app = {
      get: (key) => {
        if (key === "serverManager") return serverManager;
        if (key === "backupService") return backupService;
        return undefined;
      },
    };

    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("EPERM: operation not permitted");
    });

    const handler = getWipeHandler();
    const response = createResponse();
    try {
      await handler(
        { app, body: { targets: ["map"], confirm: true } },
        response,
      );
    } finally {
      rmSpy.mockRestore();
    }

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "WIPE_PARTIAL_FAILURE",
        backupCreated: true,
        backupName: "servertest_2026.zip",
        results: expect.any(Object),
      }),
    );
  });
});

describe("POST /api/server/wipe with createBackup: false", () => {
  it("skips the backup step entirely and deletes as before", async () => {
    const serverManager = buildServerManager();
    const backupService = {
      createBackup: vi.fn(async () => ({ success: true, backup: { name: "unused.zip" } })),
    };
    const app = {
      get: (key) => {
        if (key === "serverManager") return serverManager;
        if (key === "backupService") return backupService;
        return undefined;
      },
    };

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(
      { app, body: { targets: ["map"], confirm: true, createBackup: false } },
      response,
    );

    expect(backupService.createBackup).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, backupCreated: false, backupName: null }),
    );
    expect(fs.existsSync(path.join(saveDir, "map"))).toBe(false);
  });
});

describe("POST /api/server/wipe: players/world root-file deletion must not report a real failure as \"not found\"", () => {
  it("still reports \"not found\" and 200 for a genuinely empty players directory (unchanged behavior)", async () => {
    const serverManager = buildServerManager();
    const backupService = {
      createBackup: vi.fn(async () => ({ success: true, backup: { name: "unused.zip" } })),
    };
    const app = {
      get: (key) => {
        if (key === "serverManager") return serverManager;
        if (key === "backupService") return backupService;
        return undefined;
      },
    };

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(
      { app, body: { targets: ["players"], confirm: true, createBackup: false } },
      response,
    );

    expect(response.status).not.toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        results: expect.objectContaining({ players: "not found" }),
      }),
    );
  });

  it("surfaces WIPE_PARTIAL_FAILURE instead of a false \"not found\" when deleting a player file throws mid-loop", async () => {
    fs.writeFileSync(path.join(saveDir, "players.db"), "playerdata");

    const serverManager = buildServerManager();
    const backupService = {
      createBackup: vi.fn(async () => ({ success: true, backup: { name: "unused.zip" } })),
    };
    const app = {
      get: (key) => {
        if (key === "serverManager") return serverManager;
        if (key === "backupService") return backupService;
        return undefined;
      },
    };

    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw new Error("EBUSY: resource busy or locked");
    });

    const handler = getWipeHandler();
    const response = createResponse();
    try {
      await handler(
        { app, body: { targets: ["players"], confirm: true, createBackup: false } },
        response,
      );
    } finally {
      unlinkSpy.mockRestore();
    }

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "WIPE_PARTIAL_FAILURE" }),
    );
    const [body] = response.json.mock.calls[response.json.mock.calls.length - 1];
    expect(body.results?.players).not.toBe("not found");
    expect(fs.existsSync(path.join(saveDir, "players.db"))).toBe(true);
  });
});
