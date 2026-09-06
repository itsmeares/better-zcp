import { beforeEach, describe, expect, it, vi } from "vitest";

const { getActiveServer } = vi.hoisted(() => ({
  getActiveServer: vi.fn(),
}));

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
}));

vi.mock("../services/remoteConfigFiles.ts", () => ({
  SFTP_CONFIG_PATH_KEY: "panelBridgeSftpConfigPath",
  acquireMirrorLock: vi.fn(),
  beginRemoteConfigSession: vi.fn(),
  getMirrorPath: vi.fn(),
  isRemoteConfigConfigured: vi.fn(() => false),
  pushRemoteConfigFiles: vi.fn(),
  validateRemoteConfigTransport: vi.fn(),
}));

const {
  isLocalConfigMutation,
  isLocalConfigEdit,
  isLocalConfigOverwrite,
} = await import("../routes/serverFiles.js");
const { requireStoppedForLocalConfigMutation, warnRunningForLocalConfigEdit } =
  await import("../services/configMutationGuard.ts");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function createRequest(method, path, running = false) {
  return {
    method,
    path,
    app: {
      get: () => ({
        checkServerRunning: vi.fn(async () => running),
        getServerProcessDetails: vi.fn(async () => ({ running, scanFailed: false })),
      }),
    },
  };
}

describe("local config mutation safety", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    getActiveServer.mockResolvedValue({ isRemote: false });
  });

  it("recognizes file and template config mutations but not metadata routes", () => {
    expect(isLocalConfigMutation(createRequest("PUT", "/ini"))).toBe(true);
    expect(isLocalConfigMutation(createRequest("POST", "/restore/world.bak"))).toBe(true);
    expect(isLocalConfigMutation(createRequest("POST", "/templates/demo/apply"))).toBe(true);
    expect(isLocalConfigMutation(createRequest("POST", "/templates"))).toBe(false);
    expect(isLocalConfigMutation(createRequest("POST", "/save-and-reload"))).toBe(false);
  });

  it("classifies the nine edit routes as edits, not overwrites", () => {
    for (const routeKey of [
      "PUT /ini",
      "PUT /sandbox",
      "POST /sandbox/repair",
      "PUT /spawnpoints",
      "PUT /spawnregions",
      "PUT /raw/ini",
      "PUT /raw/sandbox",
      "PUT /raw/spawnpoints",
      "PUT /raw/spawnregions",
    ]) {
      const [method, path] = routeKey.split(" ");
      const req = createRequest(method, path);
      expect(isLocalConfigEdit(req), routeKey).toBe(true);
      expect(isLocalConfigOverwrite(req), routeKey).toBe(false);
    }
  });

  it("classifies restore and template-apply as overwrites, not edits", () => {
    const restore = createRequest("POST", "/restore/world.bak");
    const apply = createRequest("POST", "/templates/demo/apply");
    expect(isLocalConfigOverwrite(restore)).toBe(true);
    expect(isLocalConfigEdit(restore)).toBe(false);
    expect(isLocalConfigOverwrite(apply)).toBe(true);
    expect(isLocalConfigEdit(apply)).toBe(false);
  });

  it("still rejects restore and template-apply while the local server is running", async () => {
    for (const [method, path] of [
      ["POST", "/restore/world.bak"],
      ["POST", "/templates/demo/apply"],
    ]) {
      const response = createResponse();
      const next = vi.fn();

      await requireStoppedForLocalConfigMutation(
        createRequest(method, path, true),
        response,
        next,
      );

      expect(response.status, `${method} ${path}`).toHaveBeenCalledWith(409);
      expect(response.json, `${method} ${path}`).toHaveBeenCalledWith({
        code: "SERVER_RUNNING",
        error: "Stop the server before editing configuration.",
      });
      expect(next, `${method} ${path}`).not.toHaveBeenCalled();
    }
  });

  it("fails closed on a failed detection scan, not just a missing serverManager (restore/template-apply path)", async () => {
    for (const [method, path] of [
      ["POST", "/restore/world.bak"],
      ["POST", "/templates/demo/apply"],
    ]) {
      const response = createResponse();
      const next = vi.fn();
      const request = {
        method,
        path,
        app: {
          get: () => ({
            checkServerRunning: vi.fn(async () => false),
            getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: true })),
          }),
        },
      };

      await requireStoppedForLocalConfigMutation(request, response, next);

      expect(response.status, `${method} ${path}`).toHaveBeenCalledWith(503);
      expect(response.json, `${method} ${path}`).toHaveBeenCalledWith(
        expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
      );
      expect(next, `${method} ${path}`).not.toHaveBeenCalled();
    }
  });

  it("fails closed when local server state cannot be checked (restore/template-apply path)", async () => {
    const response = createResponse();
    const next = vi.fn();
    const request = createRequest("POST", "/restore/world.bak");
    request.app.get = () => ({});

    await requireStoppedForLocalConfigMutation(request, response, next);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("allows stopped and remote restore/template-apply through requireStoppedForLocalConfigMutation", async () => {
    const stoppedResponse = createResponse();
    const stoppedNext = vi.fn();
    await requireStoppedForLocalConfigMutation(
      createRequest("POST", "/restore/world.bak", false),
      stoppedResponse,
      stoppedNext,
    );
    expect(stoppedNext).toHaveBeenCalledOnce();

    getActiveServer.mockResolvedValue({ isRemote: true });
    const remoteResponse = createResponse();
    const remoteNext = vi.fn();
    await requireStoppedForLocalConfigMutation(
      createRequest("POST", "/restore/world.bak", true),
      remoteResponse,
      remoteNext,
    );
    expect(remoteNext).toHaveBeenCalledOnce();
  });

  describe("warnRunningForLocalConfigEdit (the nine edit routes)", () => {
    it("allows the write through and flags a restart warning while running", async () => {
      const response = createResponse();
      const next = vi.fn();
      const request = createRequest("PUT", "/sandbox", true);

      await warnRunningForLocalConfigEdit(request, response, next);

      expect(next).toHaveBeenCalledOnce();
      expect(response.status).not.toHaveBeenCalled();
      expect(request.configEditRestartWarning).toBe(true);
    });

    it("allows the write through with no restart warning when confirmed stopped", async () => {
      const response = createResponse();
      const next = vi.fn();
      const request = createRequest("PUT", "/ini", false);

      await warnRunningForLocalConfigEdit(request, response, next);

      expect(next).toHaveBeenCalledOnce();
      expect(request.configEditRestartWarning).toBe(false);
    });

    it("warns rather than silently assuming stopped when server state can't be checked", async () => {
      const response = createResponse();
      const next = vi.fn();
      const request = createRequest("PUT", "/ini");
      request.app.get = () => ({});

      await warnRunningForLocalConfigEdit(request, response, next);

      expect(next).toHaveBeenCalledOnce();
      expect(response.status).not.toHaveBeenCalled();
      expect(request.configEditRestartWarning).toBe(true);
    });

    it("warns rather than silently assuming stopped when getServerProcessDetails itself throws", async () => {
      const response = createResponse();
      const next = vi.fn();
      const request = {
        method: "PUT",
        path: "/ini",
        app: {
          get: () => ({
            getServerProcessDetails: vi.fn(async () => {
              throw new Error("boom");
            }),
          }),
        },
      };

      await warnRunningForLocalConfigEdit(request, response, next);

      expect(next).toHaveBeenCalledOnce();
      expect(request.configEditRestartWarning).toBe(true);
    });

    it("warns on scanFailed even when checkServerRunning would have reported false", async () => {
      const response = createResponse();
      const next = vi.fn();
      const request = {
        method: "PUT",
        path: "/ini",
        app: {
          get: () => ({
            checkServerRunning: vi.fn(async () => false),
            getServerProcessDetails: vi.fn(async () => ({
              running: false,
              scanFailed: true,
            })),
          }),
        },
      };

      await warnRunningForLocalConfigEdit(request, response, next);

      expect(next).toHaveBeenCalledOnce();
      expect(request.configEditRestartWarning).toBe(true);
    });

    it("skips the warning check entirely for a remote server", async () => {
      getActiveServer.mockResolvedValue({ isRemote: true });
      const response = createResponse();
      const next = vi.fn();
      const request = createRequest("PUT", "/ini", true);

      await warnRunningForLocalConfigEdit(request, response, next);

      expect(next).toHaveBeenCalledOnce();
      expect(request.configEditRestartWarning).toBeUndefined();
    });

    it("warns (does not treat as remote) when a configured local path is currently unreachable", async () => {
      getActiveServer.mockResolvedValue({ isRemote: true, installPath: "/nonexistent/pz-server" });
      const response = createResponse();
      const next = vi.fn();
      const request = createRequest("PUT", "/ini", true);

      await warnRunningForLocalConfigEdit(request, response, next);

      expect(next).toHaveBeenCalledOnce();
      expect(response.status).not.toHaveBeenCalled();
      expect(request.configEditRestartWarning).toBe(true);
    });
  });
});
