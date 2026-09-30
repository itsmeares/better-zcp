import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../database/init.ts", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(),
  getCurrentServer: vi.fn(async () => ({ serverName: "servertest", zomboidDataPath: "/tmp/servertest" })),
  getServers: vi.fn(async () => []),
}));

const { default: router } = await import("../routes/server.ts");

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

function getSteamUpdateHandler() {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === "/steam-update" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

describe("POST /api/server/wipe concurrency guard", () => {
  it("rejects a second wipe that arrives while the first is still validating", async () => {
    let releaseRunningCheck;
    let checkCalls = 0;
    let signalRunningCheckStarted!: () => void;
    const runningCheckStarted = new Promise<void>((resolve) => {
      signalRunningCheckStarted = resolve;
    });

    const serverManager = {
      loadConfig: async () => {},
      reloadConfig: async () => {},
      getServerProcessDetails: () => {
        checkCalls += 1;
        if (checkCalls === 1) {
          signalRunningCheckStarted();
          return new Promise((resolve) => {
            releaseRunningCheck = () =>
              resolve({ running: true, scanFailed: false });
          });
        }
        return Promise.resolve({ running: true, scanFailed: false });
      },
      savePath: null,
      serverName: "servertest",
    };

    const handler = getWipeHandler();
    const buildRequest = () => ({
      app: { get: () => serverManager },
      body: { targets: ["map"], confirm: true },
    });

    const firstResponse = createResponse();
    const secondResponse = createResponse();

    const firstCall = handler(buildRequest(), firstResponse);
    await runningCheckStarted;

    await handler(buildRequest(), secondResponse);

    expect(secondResponse.status).toHaveBeenCalledWith(409);

    releaseRunningCheck();
    await firstCall;
  });

  it("releases the guard so a later wipe is not blocked forever", async () => {
    const serverManager = {
      loadConfig: async () => {},
      reloadConfig: async () => {},
      getServerProcessDetails: async () => ({
        running: true,
        scanFailed: false,
      }),
      savePath: null,
      serverName: "servertest",
    };

    const handler = getWipeHandler();
    const request = () => ({
      app: { get: () => serverManager },
      body: { targets: ["map"], confirm: true },
    });

    const first = createResponse();
    await handler(request(), first);

    const second = createResponse();
    await handler(request(), second);

    expect(second.status).toHaveBeenCalledWith(400);
    expect(second.status).not.toHaveBeenCalledWith(409);
  });
});

describe("POST /api/server/wipe fails closed when detection can't confirm the server is stopped", () => {
  it("refuses the wipe instead of assuming the server is stopped", async () => {
    const serverManager = {
      loadConfig: async () => {},
      reloadConfig: async () => {},
      getServerProcessDetails: async () => ({
        running: false,
        scanFailed: true,
      }),
      savePath: null,
      serverName: "servertest",
    };

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(
      {
        app: { get: () => serverManager },
        body: { targets: ["map"], confirm: true },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
    );
  });
});
