import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(),
  getActiveServer: vi.fn(),
  getServers: vi.fn(),
}));

const { default: router } = await import("../routes/server.js");
const { getServers } = await import("../database/init.js");

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

// Same guard shape POST /wipe already has: refuse without confirm, refuse
// while the server is running, and fail closed (not open) when detection
// itself can't tell whether the server is running -- see d85fd42, where
// checkServerRunning() collapsing a failed scan into `false` let several
// callers treat "cannot tell" as "stopped".
describe("POST /api/server/delete-files safety guards", () => {
  let installDir;
  let serverManager;

  beforeEach(() => {
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-delete-files-"));
    // A PZ marker file, so the existing "is this really a PZ install"
    // check passes and the guards under test are the only thing left
    // that could refuse the request.
    fs.writeFileSync(path.join(installDir, "ProjectZomboid64.json"), "{}");
    serverManager = {
      loadConfig: async () => {},
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
    };
    // bug-hunt-2026-08-27: deletePath must now also match a configured
    // server's own installPath -- the marker-file check alone was
    // trivially satisfiable. Default every test to a configured server
    // pointing at installDir, so the existing guard tests (which exercise
    // everything ELSE about this route) keep exercising just that, not
    // this new check too; the new check gets its own tests below.
    getServers.mockReset();
    getServers.mockResolvedValue([{ id: 1, installPath: installDir }]);
  });

  afterEach(() => {
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
      // Own code as of 2026-08-26 bug hunt round 2 -- used to share
      // WIPE_CONFIRM_REQUIRED with /wipe; split out, see errorCodes.js.
      expect.objectContaining({ code: "DELETE_FILES_CONFIRM_REQUIRED" }),
    );
    // Refusal must be real, not just the wrong status code with the delete
    // happening anyway.
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
      // Same code /wipe uses for the same gap -- see errorCodes.js.
      expect.objectContaining({ code: "WIPE_SERVER_RUNNING" }),
    );
    expect(fs.existsSync(installDir)).toBe(true);
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

  // bug-hunt-2026-08-27: hasPzInstallMarker() only checked whether a
  // marker FILENAME exists in the target directory -- trivially satisfied
  // by creating an empty file with that name anywhere on the host. This
  // was never an authorization check, just a "does this look like a PZ
  // folder" sanity check. deletePath must now also exactly match a
  // configured server's own installPath.
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
      // The whole point: a real PZ marker file was present (see beforeEach)
      // and it must not be enough on its own -- the install must survive.
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

  // 2026-08-26 bug hunt round 2, Pam's finding 2: the entry check happens
  // once, but everything after it (path/marker validation) is synchronous --
  // getServerProcessDetails() itself is the only part of this route that
  // yields, so a server that starts DURING that scan (a second admin
  // session, a scheduler task, a supervisor auto-restart) would previously
  // sail through undetected. These simulate exactly that: the first check
  // (at route entry) sees a stopped server, but the server has started by
  // the time the SECOND check (immediately before the actual delete) runs.
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
      // The whole point: refusal must be real, the install must survive.
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

  // 2026-08-26 bug hunt round 2 follow-up, Michelle's UX audit: "Delete
  // Everything" in Servers.tsx uses this exact endpoint on installPath, with
  // only a checkbox and one click -- fine for the DEFAULT layout, where
  // resolveZomboidPaths keeps the Zomboid data folder at a sibling
  // `<installPath>_Data`, so this delete only costs a SteamCMD reinstall.
  // But nothing stopped an operator from pointing zomboidDataPath INSIDE the
  // install folder, in which case this same one-click delete also destroys
  // the world save with no separate copy -- the actual "delete that doesn't
  // look like one." These simulate that configuration directly.
  describe("refuses when the active server's Zomboid data folder is inside the folder being deleted", () => {
    it("refuses when zomboidDataPath is a subfolder of the install path being deleted", async () => {
      const dataDir = path.join(installDir, "ZomboidData");
      fs.mkdirSync(dataDir, { recursive: true });
      serverManager.savePath = dataDir;

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
      serverManager.savePath = installDir;

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
      serverManager.savePath = siblingDataDir;

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
