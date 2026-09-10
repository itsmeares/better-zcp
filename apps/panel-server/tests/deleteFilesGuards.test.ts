import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  clearActiveSteamOperation,
  getActiveSteamOperations,
} from "../services/activeSteamOperations.ts";
import { acquireLifecycleLock } from "../services/lifecycleCoordinator.ts";

vi.mock("../database/init.ts", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(),
  getActiveServer: vi.fn(),
  getServers: vi.fn(),
}));

const { default: router } = await import("../routes/server.ts");
const { getServers } = await import("../database/init.ts");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getDeleteFilesHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/delete-files" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

describe("POST /api/server/delete-files safety guards", () => {
  let installDir;
  let serverManager;

  beforeEach(() => {
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-delete-files-"));
    fs.writeFileSync(path.join(installDir, "ProjectZomboid64.json"), "{}");
    serverManager = {
      loadConfig: async () => {},
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
    };
    getServers.mockReset();
    getServers.mockResolvedValue([{ id: 1, installPath: installDir }]);
  });

  afterEach(() => {
    clearActiveSteamOperation(path.normalize(installDir).toLowerCase());
    fs.rmSync(installDir, { recursive: true, force: true });
  });

  const buildRequest = (body) => ({
    app: { get: () => serverManager },
    body: { path: installDir, ...body },
  });

  it("refuses without confirm: true", async () => {
    const handler = getDeleteFilesHandler();
    const response = createResponse();

    await handler(buildRequest({}), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "DELETE_FILES_CONFIRM_REQUIRED" }),
    );
    expect(fs.existsSync(installDir)).toBe(true);
  });

  it("refuses while the server is running", async () => {
    serverManager.getServerProcessDetails = async () => ({
      running: true,
      scanFailed: false,
    });
    const handler = getDeleteFilesHandler();
    const response = createResponse();

    await handler(buildRequest({ confirm: true }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "WIPE_SERVER_RUNNING" }),
    );
    expect(fs.existsSync(installDir)).toBe(true);
  });

  it("holds the shared lifecycle lock through the final stopped check and delete", async () => {
    let calls = 0;
    let markScanStarted;
    let releaseScan;
    const scanStarted = new Promise((resolve) => {
      markScanStarted = resolve;
    });
    serverManager.getServerProcessDetails = async () => {
      calls += 1;
      if (calls === 1) return { running: false, scanFailed: false };
      markScanStarted();
      return new Promise((resolve) => {
        releaseScan = () => resolve({ running: false, scanFailed: false });
      });
    };
    const handler = getDeleteFilesHandler();
    const response = createResponse();
    const deletePromise = handler(buildRequest({ confirm: true }), response);
    await scanStarted;

    expect(acquireLifecycleLock("start", "target")).toBeNull();
    releaseScan();
    await deletePromise;

    const lockAfterDelete = acquireLifecycleLock("start", "target");
    expect(lockAfterDelete).not.toBeNull();
    lockAfterDelete.release();
  });

  it("refuses when it cannot be determined whether the server is running (fails closed)", async () => {
    serverManager.getServerProcessDetails = async () => ({
      running: false,
      scanFailed: true,
    });
    const handler = getDeleteFilesHandler();
    const response = createResponse();

    await handler(buildRequest({ confirm: true }), response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
    );
    expect(fs.existsSync(installDir)).toBe(true);
  });

  it("still deletes on the happy path: stopped, confirmed, a real PZ install", async () => {
    const handler = getDeleteFilesHandler();
    const response = createResponse();

    await handler(buildRequest({ confirm: true }), response);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(fs.existsSync(installDir)).toBe(false);
  });

  it("refuses while SteamCMD is writing the target install path", async () => {
    const normalizedInstallPath = path.normalize(installDir).toLowerCase();
    getActiveSteamOperations().set(normalizedInstallPath, {
      type: "update",
      pid: process.pid,
    });
    const handler = getDeleteFilesHandler();
    const response = createResponse();

    await handler(buildRequest({ confirm: true }), response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "STEAM_OPERATION_IN_PROGRESS_PATH" }),
    );
    expect(fs.existsSync(installDir)).toBe(true);
  });

  describe("refuses a directory with real PZ markers that isn't a configured server's installPath", () => {
    it("refuses when no configured server points at this path (the marker file alone is not enough)", async () => {
      getServers.mockResolvedValue([]);
      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "DELETE_FILES_NOT_CONFIGURED_SERVER" }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("refuses when configured servers exist but none of them point at this exact path", async () => {
      getServers.mockResolvedValue([
        { id: 1, installPath: path.join(os.tmpdir(), "some-other-server") },
      ]);
      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "DELETE_FILES_NOT_CONFIGURED_SERVER" }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("refuses when the only configured server has no installPath set", async () => {
      getServers.mockResolvedValue([{ id: 1, installPath: null }]);
      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "DELETE_FILES_NOT_CONFIGURED_SERVER" }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("still deletes when a DIFFERENT configured server's installPath happens to also match, not just the first one", async () => {
      getServers.mockResolvedValue([
        { id: 1, installPath: path.join(os.tmpdir(), "some-other-server") },
        { id: 2, installPath: installDir },
      ]);
      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
      expect(fs.existsSync(installDir)).toBe(false);
    });
  });

  describe("re-checks immediately before the delete, not just at entry", () => {
    it("refuses when the server starts between the entry check and the delete", async () => {
      let calls = 0;
      serverManager.getServerProcessDetails = async () => {
        calls += 1;
        return calls === 1
          ? { running: false, scanFailed: false }
          : { running: true, scanFailed: false };
      };
      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(calls).toBeGreaterThanOrEqual(2);
      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "WIPE_SERVER_RUNNING" }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("fails closed when the second scan itself can't tell, even though the first scan could", async () => {
      let calls = 0;
      serverManager.getServerProcessDetails = async () => {
        calls += 1;
        return calls === 1
          ? { running: false, scanFailed: false }
          : { running: false, scanFailed: true };
      };
      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(calls).toBeGreaterThanOrEqual(2);
      expect(response.status).toHaveBeenCalledWith(503);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });
  });

  describe("refuses when the active server's Zomboid data folder is inside the folder being deleted", () => {
    it("refuses when zomboidDataPath is a subfolder of the install path being deleted", async () => {
      const dataDir = path.join(installDir, "ZomboidData");
      fs.mkdirSync(dataDir, { recursive: true });
      getServers.mockResolvedValue([
        { id: 1, installPath: installDir, zomboidDataPath: dataDir },
      ]);

      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "DELETE_FILES_DATA_PATH_NESTED" }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("refuses when zomboidDataPath equals the install path being deleted", async () => {
      getServers.mockResolvedValue([
        { id: 1, installPath: installDir, zomboidDataPath: installDir },
      ]);

      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "DELETE_FILES_DATA_PATH_NESTED" }),
      );
      expect(fs.existsSync(installDir)).toBe(true);
    });

    it("still deletes when zomboidDataPath is a sibling, not nested (the default layout)", async () => {
      const siblingDataDir = `${installDir}_Data`;
      fs.mkdirSync(siblingDataDir, { recursive: true });
      getServers.mockResolvedValue([
        { id: 1, installPath: installDir, zomboidDataPath: siblingDataDir },
      ]);

      const handler = getDeleteFilesHandler();
      const response = createResponse();

      try {
        await handler(buildRequest({ confirm: true }), response);

        expect(response.json).toHaveBeenCalledWith(
          expect.objectContaining({ success: true }),
        );
        expect(fs.existsSync(installDir)).toBe(false);
        expect(fs.existsSync(siblingDataDir)).toBe(true);
      } finally {
        fs.rmSync(siblingDataDir, { recursive: true, force: true });
      }
    });

    it("still deletes when the active server has no savePath configured at all", async () => {
      serverManager.savePath = null;

      const handler = getDeleteFilesHandler();
      const response = createResponse();

      await handler(buildRequest({ confirm: true }), response);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
      expect(fs.existsSync(installDir)).toBe(false);
    });
  });
});
