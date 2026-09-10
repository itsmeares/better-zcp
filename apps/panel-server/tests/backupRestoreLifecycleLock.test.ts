import { afterEach, describe, expect, it, vi } from "vitest";
import path from "path";


vi.mock("../database/init.ts", () => ({ getActiveServer: vi.fn() }));

const { getActiveServer } = await import("../database/init.ts");
const { default: router } = await import("../routes/backup.ts");
const {
  acquireLifecycleLock,
  isLifecycleLocked,
} = await import("../services/lifecycleCoordinator.ts");
const {
  getActiveSteamOperations,
  clearActiveSteamOperation,
} = await import("../services/activeSteamOperations.ts");

const restoreInstallPath = "/opt/restore-server";
const normalizedRestoreInstallPath = path
  .normalize(restoreInstallPath)
  .toLowerCase();

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getRestoreHandler() {
  const layer = router.stack.find((entry) => entry.route?.path === "/restore/:name");
  return layer.route.stack.at(-1).handle;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearActiveSteamOperation(normalizedRestoreInstallPath);
  const stray = acquireLifecycleLock("test-cleanup");
  if (stray) stray.release();
});

describe("POST /restore/:name takes the process-wide lifecycle lock", () => {
  it("refuses while SteamCMD is writing the active server install path", async () => {
    getActiveServer.mockResolvedValue({
      name: "TestServer",
      installPath: restoreInstallPath,
      isRemote: false,
    });
    getActiveSteamOperations().set(normalizedRestoreInstallPath, {
      type: "update",
      pid: process.pid,
    });
    const backupService = { restoreBackup: vi.fn() };
    const serverManager = {
      getServerProcessDetails: vi.fn(async () => ({
        running: false,
        scanFailed: false,
      })),
    };
    const app = {
      get: (key) =>
        key === "backupService"
          ? backupService
          : key === "serverManager"
            ? serverManager
            : {},
    };

    const response = createResponse();
    const handler = getRestoreHandler();
    await handler(
      { params: { name: "good.zip" }, body: {}, app },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "STEAM_OPERATION_IN_PROGRESS_PATH" }),
    );
    expect(backupService.restoreBackup).not.toHaveBeenCalled();
    expect(serverManager.getServerProcessDetails).not.toHaveBeenCalled();
  });

  it("holds the lock for the duration of the restore and releases it on success", async () => {
    getActiveServer.mockResolvedValue({ name: "TestServer", isRemote: false });
    const restoreGate = deferred();
    const backupService = {
      restoreBackup: vi.fn(() => restoreGate.promise),
    };
    const serverManager = {
      getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
    };
    const app = {
      get: (key) =>
        key === "backupService" ? backupService : key === "serverManager" ? serverManager : {},
    };

    const handler = getRestoreHandler();
    const response = createResponse();

    expect(isLifecycleLocked()).toBe(false);
    const handlerPromise = handler(
      { params: { name: "good.zip" }, body: {}, app },
      response,
    );

    await vi.waitFor(() => expect(backupService.restoreBackup).toHaveBeenCalled());
    expect(isLifecycleLocked()).toBe(true);

    const concurrent = acquireLifecycleLock("start", "TestServer");
    expect(concurrent).toBeNull();

    restoreGate.resolve({ success: true, message: "Restored" });
    await handlerPromise;

    expect(isLifecycleLocked()).toBe(false);
    expect(response.json).toHaveBeenCalledWith({ success: true, message: "Restored" });
  });

  it("refuses with 409 when another lifecycle operation already holds the lock, without ever calling restoreBackup()", async () => {
    getActiveServer.mockResolvedValue({ name: "TestServer", isRemote: false });
    const backupService = { restoreBackup: vi.fn() };
    const serverManager = {
      getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
    };
    const app = {
      get: (key) =>
        key === "backupService" ? backupService : key === "serverManager" ? serverManager : {},
    };

    const held = acquireLifecycleLock("start", "TestServer");
    expect(held).not.toBeNull();

    const handler = getRestoreHandler();
    const response = createResponse();
    await handler({ params: { name: "good.zip" }, body: {}, app }, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(backupService.restoreBackup).not.toHaveBeenCalled();

    held.release();
  });

  it("releases the lock even when restoreBackup() throws", async () => {
    getActiveServer.mockResolvedValue({ name: "TestServer", isRemote: false });
    const backupService = {
      restoreBackup: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const serverManager = {
      getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
    };
    const app = {
      get: (key) =>
        key === "backupService" ? backupService : key === "serverManager" ? serverManager : {},
    };

    const handler = getRestoreHandler();
    const response = createResponse();
    await handler({ params: { name: "good.zip" }, body: {}, app }, response);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(isLifecycleLocked()).toBe(false);
  });
});
