import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";


vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => ({ isRemote: false })),
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/backup.js");

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

let restoreBackup;
let services;

beforeEach(() => {
  restoreBackup = vi.fn(async () => ({ success: true }));
  services = {
    backupService: { restoreBackup },
    io: { emit: vi.fn() },
  };
});

function postRestore(serverManager) {
  services.serverManager = serverManager;
  return runRoute("/restore/:name", "post", {
    user: { role: "admin" },
    params: { name: "good.zip" },
    body: {},
    app: { get: (key) => services[key] },
  });
}

describe("backup.js POST /restore/:name: an undetermined server state must refuse, not be read as 'stopped'", () => {
  it("refuses with SERVER_STATE_UNKNOWN and never calls restoreBackup when the running-scan itself failed (scanFailed:true)", async () => {
    const res = await postRestore({
      checkServerRunning: async () => false,
      getServerProcessDetails: async () => ({ running: false, scanFailed: true }),
    });

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it("still refuses with BACKUP_RESTORE_SERVER_RUNNING on a confirmed-running server", async () => {
    const res = await postRestore({
      checkServerRunning: async () => true,
      getServerProcessDetails: async () => ({ running: true, scanFailed: false }),
    });

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({ code: "BACKUP_RESTORE_SERVER_RUNNING" });
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it("proceeds when the scan confirms the server is stopped (running:false, scanFailed:false)", async () => {
    const res = await postRestore({
      checkServerRunning: async () => false,
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
    });

    expect(res.getStatusCode()).toBe(200);
    expect(restoreBackup).toHaveBeenCalledWith("good.zip", expect.anything());
  });
});

const STOPPED_SERVER_MANAGER = {
  checkServerRunning: async () => false,
  getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
};

describe("backup.js POST /restore/:name: failure messages are sanitized surgically, not with a blanket redact", () => {
  it("redacts a filesystem path out of an ordinary/unexpected failure message", async () => {
    restoreBackup.mockResolvedValueOnce({
      success: false,
      message: "ENOENT: no such file or directory, rename 'C:\\Users\\test-user\\AppData\\Local\\ZomboidPanel\\Saves' -> 'C:\\Users\\test-user\\AppData\\Local\\ZomboidPanel\\Saves.replaced-123'",
    });

    const res = await postRestore(STOPPED_SERVER_MANAGER);

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().message).not.toContain("C:\\Users\\test-user");
    expect(res.getBody().message).toContain("[path]");
  });

  it("does NOT redact the rollback-failure message -- the recovery path must survive intact", async () => {
    const recoveryPath = "C:\\Users\\test-user\\AppData\\Local\\ZomboidPanel\\Saves.replaced-1735500000000";
    restoreBackup.mockResolvedValueOnce({
      success: false,
      message: `Restore failed and the previous save could not be put back automatically. It is preserved at ${recoveryPath}.`,
    });

    const res = await postRestore(STOPPED_SERVER_MANAGER);

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().message).toContain(recoveryPath);
  });

  it("leaves an ordinary short, pathless failure message unchanged", async () => {
    restoreBackup.mockResolvedValueOnce({
      success: false,
      message: "Invalid backup file",
    });

    const res = await postRestore(STOPPED_SERVER_MANAGER);

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().message).toBe("Invalid backup file");
  });
});
