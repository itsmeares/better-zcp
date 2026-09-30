import { beforeEach, describe, expect, it, vi } from "vite-plus/test";


const getCurrentServer = vi.fn();
vi.mock("../database/init.ts", () => ({ getCurrentServer }));

const fakeGameIntegration = { isConnected: vi.fn(() => false) };
vi.mock("../utils/panelRuntime.ts", () => ({ getPanelRuntime: () => ({ gameIntegration: fakeGameIntegration }) }));

const resolveDockerHostSignal = vi.fn();
vi.mock("../services/managedContainer.ts", () => ({ resolveDockerHostSignal }));

const { resolveObservedServerRunning } = await import("../utils/serverStatus.ts");

function fakeServerManager(details) {
  return { getServerProcessDetails: vi.fn(async () => details) };
}

describe("resolveObservedServerRunning", () => {
  beforeEach(() => {
    getCurrentServer.mockReset();
    fakeGameIntegration.isConnected.mockReset().mockReturnValue(false);
    resolveDockerHostSignal.mockReset();
  });

  it("reports UNKNOWN (null), not a confident offline, when the scan itself failed and nothing else confirms it", async () => {
    getCurrentServer.mockResolvedValue({ id: "s1" });
    const serverManager = fakeServerManager({
      running: false,
      scanFailed: true,
    });
    const rconService = { connected: false };

    expect(
      await resolveObservedServerRunning(serverManager, rconService),
    ).toBeNull();
  });

  it("still reports OFFLINE (false) when every signal genuinely agrees the server is down", async () => {
    getCurrentServer.mockResolvedValue({ id: "s1" });
    const serverManager = fakeServerManager({
      running: false,
      scanFailed: false,
    });
    const rconService = { connected: false };

    expect(await resolveObservedServerRunning(serverManager, rconService)).toBe(
      false,
    );
  });

  it("reports RUNNING for a docker-managed server whose local scan can't see it but the container is up", async () => {
    getCurrentServer.mockResolvedValue({
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
});
