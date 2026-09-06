import { beforeEach, describe, expect, it, vi } from "vitest";


const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({ getActiveServer }));

const fakeBridge = { isModConnected: vi.fn(() => false) };
vi.mock("../services/panelBridge.js", () => ({ default: fakeBridge }));

const resolveDockerHostSignal = vi.fn();
vi.mock("../services/managedContainer.js", () => ({ resolveDockerHostSignal }));

const { resolveObservedServerRunning } = await import("../utils/serverStatus.ts");

function fakeServerManager(details) {
  return { getServerProcessDetails: vi.fn(async () => details) };
}

describe("resolveObservedServerRunning -- split-container / cross-container RCON", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    fakeBridge.isModConnected.mockReset().mockReturnValue(false);
    resolveDockerHostSignal.mockReset();
  });

  it("reports RUNNING when the local scan finds nothing but RCON is connected (remote provider) -- the exact split-container shape", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", isRemote: true });
    const serverManager = fakeServerManager({ running: false, scanFailed: false });
    const rconService = { connected: true };

    expect(await resolveObservedServerRunning(serverManager, rconService)).toBe(true);
  });

  it("reports RUNNING off the bridge alone when RCON is also disconnected", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", isRemote: true });
    const serverManager = fakeServerManager({ running: false, scanFailed: false });
    fakeBridge.isModConnected.mockReturnValue(true);

    expect(await resolveObservedServerRunning(serverManager, { connected: false })).toBe(true);
  });

  it("reports UNKNOWN (null), not a confident offline, when the scan itself failed and nothing else confirms it", async () => {
    getActiveServer.mockResolvedValue({ id: "s1" });
    const serverManager = fakeServerManager({ running: false, scanFailed: true });
    const rconService = { connected: false };

    expect(await resolveObservedServerRunning(serverManager, rconService)).toBeNull();
  });

  it("still reports OFFLINE (false) when every signal genuinely agrees the server is down", async () => {
    getActiveServer.mockResolvedValue({ id: "s1" });
    const serverManager = fakeServerManager({ running: false, scanFailed: false });
    const rconService = { connected: false };

    expect(await resolveObservedServerRunning(serverManager, rconService)).toBe(false);
  });

  it("reports RUNNING for a docker-managed server whose local scan can't see it but the container is up", async () => {
    getActiveServer.mockResolvedValue({
      id: "s1",
      provider: "docker-managed",
      dockerContainerName: "pz",
    });
    resolveDockerHostSignal.mockResolvedValue({ running: true, scanFailed: false });
    const serverManager = fakeServerManager({ running: false, scanFailed: false });

    expect(
      await resolveObservedServerRunning(serverManager, { connected: false }),
    ).toBe(true);
    expect(serverManager.getServerProcessDetails).not.toHaveBeenCalled();
  });

  it("reports RUNNING for a remote-sftp server via RCON alone (no local process to scan)", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", isRemote: true });
    const serverManager = fakeServerManager({ running: true, scanFailed: false });

    expect(
      await resolveObservedServerRunning(serverManager, { connected: true }),
    ).toBe(true);
    expect(serverManager.getServerProcessDetails).not.toHaveBeenCalled();
  });
});
