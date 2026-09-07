import { describe, expect, it, vi } from "vitest";


const setSettingMock = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(async () => null),
  getAllSettings: vi.fn(async () => ({})),
  setSetting: setSettingMock,
  getDb: vi.fn(async () => ({ data: {} })),
  commitNow: vi.fn(async () => {}),
  logBridgeCommand: vi.fn(async () => {}),
  getRoleByName: vi.fn(async () => null),
}));

const bridgeMock = {
  configure: vi.fn((p) => p),
  start: vi.fn(),
  stop: vi.fn(),
  stopSftp: vi.fn(async () => {}),
  isRunning: false,
};

vi.mock("../services/panelBridge.ts", () => ({ default: bridgeMock }));

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

function getRouteHandler(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const zomboidSavePath =
  process.platform === "win32" ? "D:\\pz-verify\\Zomboid" : "/pz-verify/Zomboid";
const configuredBridgePath =
  process.platform === "win32"
    ? "D:\\pz-verify\\Zomboid\\panelbridge"
    : "/pz-verify/Zomboid/panelbridge";
const directBridgePath =
  process.platform === "win32"
    ? "D:\\pz-verify\\Zomboid\\Lua\\panelbridge\\pz-verify"
    : "/pz-verify/Zomboid/Lua/panelbridge/pz-verify";

describe("panelBridge.js /configure and /configure-direct persist bridgePath to settings", () => {
  it("POST /configure writes settings.panelBridge.bridgePath after a successful configure", async () => {
    setSettingMock.mockClear();
    bridgeMock.configure.mockReturnValueOnce(configuredBridgePath);
    const { default: router } = await import("../routes/panelBridge.js");
    const res = createResponse();
    await getRouteHandler(router, "/configure", "post")(
      { body: { zomboidSavePath } },
      res,
    );
    expect(res.getStatusCode()).toBe(200);
    expect(setSettingMock).toHaveBeenCalledWith("panelBridge", {
      bridgePath: configuredBridgePath,
    });
  });

  it("POST /configure-direct writes settings.panelBridge.bridgePath after a successful configure -- the manual escape hatch that can't self-heal via auto-detect", async () => {
    setSettingMock.mockClear();
    bridgeMock.configure.mockReturnValueOnce(directBridgePath);
    const { default: router } = await import("../routes/panelBridge.js");
    const res = createResponse();
    await getRouteHandler(router, "/configure-direct", "post")(
      { body: { bridgePath: directBridgePath } },
      res,
    );
    expect(res.getStatusCode()).toBe(200);
    expect(setSettingMock).toHaveBeenCalledWith("panelBridge", {
      bridgePath: directBridgePath,
    });
  });
});
