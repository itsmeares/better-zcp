import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const createServer = vi.fn();
const updateServer = vi.fn();
const getServers = vi.fn();
const getSetting = vi.fn();
const getAllSettings = vi.fn();
const testRconConnection = vi.fn();

import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.js", () => ({
  getServers,
  getSetting,
  getAllSettings,
  getServer: vi.fn(),
  getActiveServer: vi.fn(),
  createServer,
  updateServer,
  deleteServer: vi.fn(),
  setActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
}));

vi.mock("../services/rcon.js", () => ({
  normalizeRconHost: (host) => host.trim(),
  testRconConnection,
}));

const { default: router } = await import("../routes/servers.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getLayer(routePath, method) {
  return router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

function getCreateHandler() {
  const layer = getLayer("/", "post");
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getUpdateHandler() {
  const layer = getLayer("/:id", "put");
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

// HARDEN (operator ruling 2026-08-27, card
// custom-launcher-as-a-real-supported-mode-not-an-accident): neither
// installPath nor serverPath was validated at all before this -- an
// unvalidated path that silently changes launch behavior (MANAGED vs
// CUSTOM LAUNCHER -- see serverManager.js's resolveLaunchMode(), the same
// predicate this validation calls) was the whole bug. Both shapes must
// keep working: a directory (today's default) and a .bat/.sh/.exe launcher
// (the operator's own script, real and supported, not an accident).
describe("installPath/serverPath shape validation (POST / and PUT /:id)", () => {
  let tmpRoot;

  beforeEach(() => {
    createServer.mockReset();
    updateServer.mockReset();
    getSetting.mockReset();
    getSetting.mockResolvedValue("");
    createServer.mockResolvedValue({ id: "server-id", name: "Test Server" });
    updateServer.mockResolvedValue({ id: "1", name: "Test Server", isActive: false });
  });

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  });

  function baseCreateBody(overrides = {}) {
    return {
      name: "Test Server",
      installPath: "C:\\PZ",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      rconPassword: "rcon-password",
      ...overrides,
    };
  }

  describe("MANAGED mode (directory-shaped)", () => {
    it("POST / still accepts a not-yet-existing directory path -- fresh installs must keep working", async () => {
      const response = createResponse();
      await getCreateHandler()({ body: baseCreateBody() }, response);
      expect(createServer).toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(201);
    });

    it("POST / accepts a real, already-existing directory", async () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-install-valid-"));
      const response = createResponse();
      await getCreateHandler()(
        { body: baseCreateBody({ installPath: tmpRoot }) },
        response,
      );
      expect(createServer).toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(201);
    });

    it("POST / rejects a path that already exists as a plain file with no recognized launcher extension -- the exact unvalidated case that used to silently break regeneration", async () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-install-badfile-"));
      const badFile = path.join(tmpRoot, "readme.txt");
      fs.writeFileSync(badFile, "not a launcher", "utf8");
      const response = createResponse();

      await getCreateHandler()(
        { body: baseCreateBody({ installPath: badFile }) },
        response,
      );

      expect(createServer).not.toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(400);
    });

    it("PUT /:id rejects the same bad shape for installPath", async () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-install-badfile2-"));
      const badFile = path.join(tmpRoot, "notes.docx");
      fs.writeFileSync(badFile, "not a launcher", "utf8");
      const response = createResponse();

      await getUpdateHandler()(
        { params: { id: "1" }, body: { installPath: badFile } },
        response,
      );

      expect(updateServer).not.toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(400);
    });

    it("PUT /:id rejects the same bad shape for serverPath", async () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-install-badfile3-"));
      const badFile = path.join(tmpRoot, "notes.docx");
      fs.writeFileSync(badFile, "not a launcher", "utf8");
      const response = createResponse();

      await getUpdateHandler()(
        { params: { id: "1" }, body: { serverPath: badFile } },
        response,
      );

      expect(updateServer).not.toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(400);
    });
  });

  describe("CUSTOM LAUNCHER mode (.bat/.sh/.exe) -- real and supported, not an error", () => {
    it("POST / accepts a .bat launcher path that doesn't exist yet -- the operator may configure this before the file is in place", async () => {
      const response = createResponse();
      await getCreateHandler()(
        {
          body: baseCreateBody({
            installPath: "D:\\PZServer\\MyCustomLauncher.bat",
          }),
        },
        response,
      );
      expect(createServer).toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(201);
    });

    it("PUT /:id accepts a .sh launcher for serverPath", async () => {
      const response = createResponse();
      await getUpdateHandler()(
        {
          params: { id: "1" },
          body: { serverPath: "/opt/pz/custom-launch.sh" },
        },
        response,
      );
      expect(updateServer).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ serverPath: "/opt/pz/custom-launch.sh" }),
      );
      expect(response.status).not.toHaveBeenCalledWith(400);
    });

    it("PUT /:id accepts a .exe launcher for installPath, case-insensitively", async () => {
      const response = createResponse();
      await getUpdateHandler()(
        {
          params: { id: "1" },
          body: { installPath: "C:\\PZ\\CustomLauncher.EXE" },
        },
        response,
      );
      expect(updateServer).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ installPath: "C:\\PZ\\CustomLauncher.EXE" }),
      );
      expect(response.status).not.toHaveBeenCalledWith(400);
    });

    it("an existing file-shaped installPath value keeps working on update -- EXISTING VALUES MUST KEEP RESOLVING, not become an error", async () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-install-launcher-"));
      const launcherPath = path.join(tmpRoot, "run.sh");
      fs.writeFileSync(launcherPath, "#!/bin/bash\necho hi\n", "utf8");
      const response = createResponse();

      await getUpdateHandler()(
        { params: { id: "1" }, body: { installPath: launcherPath } },
        response,
      );

      expect(updateServer).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ installPath: launcherPath }),
      );
      expect(response.status).not.toHaveBeenCalledWith(400);
    });
  });

  describe("edge cases", () => {
    it("rejects a NUL-byte payload instead of persisting it", async () => {
      const response = createResponse();
      await getCreateHandler()(
        { body: baseCreateBody({ installPath: "C:\\PZ\u0000evil" }) },
        response,
      );
      expect(createServer).not.toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(400);
    });

    it("PUT /:id clearing serverPath with an empty string is allowed, not validated as a shape", async () => {
      const response = createResponse();
      await getUpdateHandler()(
        { params: { id: "1" }, body: { serverPath: "" } },
        response,
      );
      expect(updateServer).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ serverPath: "" }),
      );
      expect(response.status).not.toHaveBeenCalledWith(400);
    });

    it("PUT /:id preserves a cleared Docker container as JSON null", async () => {
      const response = createResponse();
      await getUpdateHandler()(
        { params: { id: "1" }, body: { dockerContainerName: null } },
        response,
      );

      expect(updateServer).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ dockerContainerName: null }),
      );
    });
  });
});
