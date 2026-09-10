import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveServer = vi.fn();

vi.mock("../database/init.ts", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
  getRoleByName: vi.fn(),
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

const { default: router } = await import("../routes/serverFiles.ts");

function getUseLayers() {
  return router.stack.filter((entry) => !entry.route).map((entry) => entry.handle);
}

describe("server-files request context", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
  });

  it("reuses the active-server snapshot across the config gate and remote gate", async () => {
    const activeServer = {
      serverName: "Alpha",
      serverConfigPath: "/srv/alpha/Server",
      isRemote: false,
    };
    getActiveServer.mockResolvedValueOnce(activeServer).mockResolvedValue({
      serverName: "Beta",
      serverConfigPath: "/srv/beta/Server",
      isRemote: false,
    });

    const req = { path: "/paths", method: "GET" };
    const res = { status: vi.fn(), json: vi.fn() };
    const next = vi.fn();
    const [, gate, remoteGate] = getUseLayers();

    await gate(req, res, next);
    await remoteGate(req, res, next);

    expect(getActiveServer).toHaveBeenCalledTimes(1);
    expect(req.activeServerContext).toMatchObject({
      activeServer,
      serverConfigPath: "/srv/alpha/Server",
      serverName: "Alpha",
    });
    expect(next).toHaveBeenCalledTimes(2);
  });
});
