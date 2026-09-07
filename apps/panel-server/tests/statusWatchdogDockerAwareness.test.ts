import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const getActiveServer = vi.fn();
vi.mock("../database/init.ts", () => ({ getActiveServer }));

const resolveDockerHostSignal = vi.fn();
vi.mock("../services/managedContainer.ts", () => ({
  setDockerClient: vi.fn(),
  resolveDockerHostSignal,
}));

const { getObservedServerRunning } = await import("../index.ts");
const { ServerManager } = await import("../services/serverManager.ts");

describe("status watchdog -- Docker provider awareness", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    resolveDockerHostSignal.mockReset();
    vi.spyOn(ServerManager.prototype, "getServerProcessDetails").mockResolvedValue({
      running: false,
      scanFailed: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("trusts the Docker signal over the (always-blind) local process scan for docker-local", async () => {
    getActiveServer.mockResolvedValue({
      id: "docker-server",
      dockerContainerName: "pz-container",
      isRemote: false,
    });
    resolveDockerHostSignal.mockResolvedValue({ running: true, scanFailed: false });

    const running = await getObservedServerRunning();

    expect(running).toBe(true);
    expect(resolveDockerHostSignal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "docker-server", dockerContainerName: "pz-container" }),
      expect.anything(),
    );
    expect(ServerManager.prototype.getServerProcessDetails).not.toHaveBeenCalled();
  });

  it("reports unknown (not a confident stopped) when Docker control can't verify", async () => {
    getActiveServer.mockResolvedValue({
      id: "docker-server",
      dockerContainerName: "pz-container",
      isRemote: false,
    });
    resolveDockerHostSignal.mockResolvedValue({ running: false, scanFailed: true });

    expect(await getObservedServerRunning()).toBeNull();
  });

  it("still uses the local process scan for a native server, not the Docker signal", async () => {
    getActiveServer.mockResolvedValue({ id: "native-server", isRemote: false });
    ServerManager.prototype.getServerProcessDetails.mockResolvedValue({
      running: true,
      scanFailed: false,
    });

    expect(await getObservedServerRunning()).toBe(true);
    expect(resolveDockerHostSignal).not.toHaveBeenCalled();
  });
});
