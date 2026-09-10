import { beforeEach, describe, expect, it, vi } from "vitest";


let getStatusReturn;
let isModConnectedReturn;
vi.mock("../services/panelBridge.ts", () => ({
  default: {
    getStatus: () => getStatusReturn,
    isModConnected: () => isModConnectedReturn,
  },
}));

let activeServer;
vi.mock("../database/init.ts", () => ({
  getActiveServer: vi.fn(async () => activeServer),
  getRoleByName: vi.fn(),
}));

const { default: router } = await import("../routes/panelBridge.ts");
const { getBundledBridgeVersion } = await import(
  "../services/panelBridgeInstaller.ts"
);

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  return { json: vi.fn() };
}

beforeEach(() => {
  getStatusReturn = { alive: false };
  isModConnectedReturn = false;
});

describe("GET /panel-bridge/status -- remote servers get a version-string check, not a misleading local-install status", () => {
  it("reports remoteBridgeVersionCheck and leaves localInstall null for a remote server", async () => {
    activeServer = { id: "s1", name: "Remote Server", isRemote: true };
    getStatusReturn = { alive: true, version: "0.0.1" };

    const response = createResponse();
    await getHandler("/status", "get")({}, response);

    const payload = response.json.mock.calls[0][0];
    expect(payload.localInstall).toBeNull();
    expect(payload.remoteBridgeVersionCheck).toEqual({
      bundledVersion: getBundledBridgeVersion(),
      liveVersion: "0.0.1",
      behind: true,
    });
  });

  it("reports behind:false when the remote live version matches what's bundled", async () => {
    activeServer = { id: "s1", isRemote: true };
    getStatusReturn = { alive: true, version: getBundledBridgeVersion() };

    const response = createResponse();
    await getHandler("/status", "get")({}, response);

    expect(
      response.json.mock.calls[0][0].remoteBridgeVersionCheck.behind,
    ).toBe(false);
  });

  it("reports behind:null when the remote server has never reported a live version", async () => {
    activeServer = { id: "s1", isRemote: true };
    getStatusReturn = { alive: false, version: null };

    const response = createResponse();
    await getHandler("/status", "get")({}, response);

    const check = response.json.mock.calls[0][0].remoteBridgeVersionCheck;
    expect(check.liveVersion).toBeNull();
    expect(check.behind).toBeNull();
  });

  it("still reports localInstall (not remoteBridgeVersionCheck) for a local server -- unchanged behavior", async () => {
    activeServer = {
      id: "s1",
      isRemote: false,
      installPath: "/does/not/exist/anywhere",
    };

    const response = createResponse();
    await getHandler("/status", "get")({}, response);

    const payload = response.json.mock.calls[0][0];
    expect(payload.remoteBridgeVersionCheck).toBeNull();
    expect(payload.localInstall).toEqual(
      expect.objectContaining({ canAutoInstall: false }),
    );
  });

  it("leaves both null when there is no active server at all", async () => {
    activeServer = null;

    const response = createResponse();
    await getHandler("/status", "get")({}, response);

    const payload = response.json.mock.calls[0][0];
    expect(payload.localInstall).toBeNull();
    expect(payload.remoteBridgeVersionCheck).toBeNull();
  });
});
