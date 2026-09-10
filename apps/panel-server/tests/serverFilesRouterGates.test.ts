import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const getActiveServer = vi.fn();
const getAllSettings = vi.fn();

vi.mock("../database/init.ts", () => ({
  getActiveServer,
  getAllSettings,
}));

const isRemoteConfigConfigured = vi.fn(() => false);
vi.mock("../services/remoteConfigFiles.ts", () => ({
  SFTP_CONFIG_PATH_KEY: "panelBridgeSftpConfigPath",
  acquireMirrorLock: vi.fn(async () => () => {}),
  beginRemoteConfigSession: vi.fn(async () => ({})),
  getMirrorPath: vi.fn(async () => "/tmp/mirror"),
  isRemoteConfigConfigured,
  pushRemoteConfigFiles: vi.fn(async () => {}),
  validateRemoteConfigTransport: vi.fn(() => null),
}));

const { default: router } = await import("../routes/serverFiles.ts");

function getUseLayers() {
  return router.stack.filter((entry) => !entry.route).map((entry) => entry.handle);
}

function fakeReq(overrides = {}) {
  return { path: "/", url: "/", method: "GET", app: { get: () => undefined }, ...overrides };
}

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = null;
  let jsonBody = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (body) => {
    jsonBody = body;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getJson = () => jsonBody;
  return response;
}

async function runLayer(handle, req) {
  const res = createResponse();
  let nextCalledWith = "not-called";
  await handle(req, res, (err) => {
    nextCalledWith = err ?? "called";
  });
  return { res, nextCalledWith };
}

describe("serverFiles.ts router.use layers beyond the requirePermission gate", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    getAllSettings.mockReset().mockResolvedValue({});
    isRemoteConfigConfigured.mockReset().mockReturnValue(false);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("layer[2] (line 88): remote-mirror gate", () => {
    it("a local active server -- passes straight through, no SFTP anything touched", async () => {
      getActiveServer.mockResolvedValue({ isRemote: false });
      const [, , layer88] = getUseLayers();
      const { nextCalledWith } = await runLayer(layer88, fakeReq());
      expect(nextCalledWith).toBe("called");
    });

    it("a remote active server on a local-filesystem-only path (/browse-files) -- refused, not mirrored", async () => {
      getActiveServer.mockResolvedValue({ isRemote: true });
      const [, , layer88] = getUseLayers();
      const { res, nextCalledWith } = await runLayer(
        layer88,
        fakeReq({ path: "/browse-files" }),
      );
      expect(res.getStatusCode()).toBe(400);
      expect(res.getJson()).toMatchObject({ code: "REMOTE_BROWSE_NOT_AVAILABLE" });
      expect(nextCalledWith).toBe("not-called");
    });

    it("a remote active server with SFTP not configured -- refused with REMOTE_CONFIG_NOT_CONFIGURED, no mirror session attempted", async () => {
      getActiveServer.mockResolvedValue({ isRemote: true });
      isRemoteConfigConfigured.mockReturnValue(false);
      const [, , layer88] = getUseLayers();
      const { res, nextCalledWith } = await runLayer(layer88, fakeReq({ path: "/ini" }));
      expect(res.getStatusCode()).toBe(400);
      expect(res.getJson()).toMatchObject({ code: "REMOTE_CONFIG_NOT_CONFIGURED" });
      expect(nextCalledWith).toBe("not-called");
    });
  });

  describe("layer[3] (line 238): wholesale-overwrite vs ordinary-edit routing -- 238's requireStoppedForLocalConfigMutation branch has fail-open history (92d2772)", () => {
    function stubManager(details) {
      return {
        get: (key) => (key === "serverManager" ? {
          reloadConfig: async () => {},
          getServerProcessDetails: async () => details,
        } : undefined),
      };
    }
    function stubEditManager(running) {
      return {
        get: (key) =>
          key === "serverManager"
            ? {
                reloadConfig: async () => {},
                getServerProcessDetails: async () => ({ running, scanFailed: false }),
              }
            : undefined,
      };
    }

    it("POST /restore/:name (overwrite) while the server IS running -- 409 SERVER_RUNNING, refused", async () => {
      getActiveServer.mockResolvedValue({ isRemote: false });
      const [, , , layer238] = getUseLayers();
      const { res, nextCalledWith } = await runLayer(
        layer238,
        fakeReq({
          method: "POST",
          path: "/restore/mysave",
          app: stubManager({ running: true, scanFailed: false }),
        }),
      );
      expect(res.getStatusCode()).toBe(409);
      expect(res.getJson()).toMatchObject({ code: "SERVER_RUNNING" });
      expect(nextCalledWith).toBe("not-called");
    });

    it("POST /restore/:name while the server is confirmed stopped -- passes through", async () => {
      getActiveServer.mockResolvedValue({ isRemote: false });
      const [, , , layer238] = getUseLayers();
      const { nextCalledWith } = await runLayer(
        layer238,
        fakeReq({
          method: "POST",
          path: "/restore/mysave",
          app: stubManager({ running: false, scanFailed: false }),
        }),
      );
      expect(nextCalledWith).toBe("called");
    });

    it("POST /restore/:name when the process-detection scan itself fails -- 503 SERVER_STATE_UNKNOWN, refused (fail-closed, the 92d2772 fix)", async () => {
      getActiveServer.mockResolvedValue({ isRemote: false });
      const [, , , layer238] = getUseLayers();
      const { res, nextCalledWith } = await runLayer(
        layer238,
        fakeReq({
          method: "POST",
          path: "/restore/mysave",
          app: stubManager({ running: false, scanFailed: true }),
        }),
      );
      expect(res.getStatusCode()).toBe(503);
      expect(res.getJson()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
      expect(nextCalledWith).toBe("not-called");
    });

    it("POST /templates/:name/apply (also a wholesale overwrite) while running -- same 409 refusal as /restore", async () => {
      getActiveServer.mockResolvedValue({ isRemote: false });
      const [, , , layer238] = getUseLayers();
      const { res } = await runLayer(
        layer238,
        fakeReq({
          method: "POST",
          path: "/templates/vanilla/apply",
          app: stubManager({ running: true, scanFailed: false }),
        }),
      );
      expect(res.getStatusCode()).toBe(409);
    });

    it("an overwrite on a remote server skips the local process check entirely -- passes through", async () => {
      getActiveServer.mockResolvedValue({ isRemote: true });
      const [, , , layer238] = getUseLayers();
      const { nextCalledWith } = await runLayer(
        layer238,
        fakeReq({ method: "POST", path: "/restore/mysave" }),
      );
      expect(nextCalledWith).toBe("called");
    });

    it("PUT /ini (an ordinary edit, not an overwrite) while running -- never blocks, but flags the restart warning", async () => {
      getActiveServer.mockResolvedValue({ isRemote: false });
      const [, , , layer238] = getUseLayers();
      const req = fakeReq({ method: "PUT", path: "/ini", app: stubEditManager(true) });
      const { nextCalledWith } = await runLayer(layer238, req);
      expect(nextCalledWith).toBe("called");
      expect(req.configEditRestartWarning).toBe(true);
    });

    it("PUT /ini while stopped -- passes through with no restart warning", async () => {
      getActiveServer.mockResolvedValue({ isRemote: false });
      const [, , , layer238] = getUseLayers();
      const req = fakeReq({ method: "PUT", path: "/ini", app: stubEditManager(false) });
      const { nextCalledWith } = await runLayer(layer238, req);
      expect(nextCalledWith).toBe("called");
      expect(req.configEditRestartWarning).toBe(false);
    });

    it("a route that is neither an overwrite nor a tracked edit (e.g. GET /ini) -- passes straight through untouched", async () => {
      const [, , , layer238] = getUseLayers();
      const { nextCalledWith } = await runLayer(
        layer238,
        fakeReq({ method: "GET", path: "/ini" }),
      );
      expect(nextCalledWith).toBe("called");
      expect(getActiveServer).not.toHaveBeenCalled();
    });
  });
});
