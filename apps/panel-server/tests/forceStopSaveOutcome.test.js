import { beforeEach, describe, expect, it, vi } from "vitest";


vi.mock("../database/init.ts", () => ({
  getActiveServer: vi.fn(async () => ({ isRemote: false })),
}));

vi.mock("../services/managedContainer.ts", () => ({
  runManagedLifecycle: vi.fn(),
}));

const { runManagedLifecycle } = await import("../services/managedContainer.ts");
const { default: router } = await import("../routes/server.ts");

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function makeApp({ rconService, serverManager, io }) {
  return {
    get: (key) => {
      if (key === "rconService") return rconService;
      if (key === "serverManager") return serverManager;
      if (key === "io") return io;
      return null;
    },
  };
}

describe("POST /server/force-stop -- bounded, fail-open pre-stop save", () => {
  beforeEach(() => {
    runManagedLifecycle.mockReset();
  });

  it("saves successfully, then proceeds with the Docker stop (saveOutcome: 'saved')", async () => {
    runManagedLifecycle.mockResolvedValue({
      handled: true,
      success: true,
      message: "Container stopped",
    });
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: true }),
    };
    const response = createResponse();

    await getHandler("/force-stop", "post")(
      { app: makeApp({ rconService, serverManager: {}, io: { emit: vi.fn() } }) },
      response,
    );

    expect(rconService.save).toHaveBeenCalledWith({ retryOnConnectionError: false });
    expect(runManagedLifecycle).toHaveBeenCalledWith("stop", { serverId: null });
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, saveOutcome: "saved" }),
    );
  });

  it("proceeds with the stop even when the save fails -- NOT blocked (saveOutcome: 'failed')", async () => {
    runManagedLifecycle.mockResolvedValue({
      handled: true,
      success: true,
      message: "Container stopped",
    });
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: false, error: "disk full" }),
    };
    const response = createResponse();

    await getHandler("/force-stop", "post")(
      { app: makeApp({ rconService, serverManager: {}, io: { emit: vi.fn() } }) },
      response,
    );

    expect(runManagedLifecycle).toHaveBeenCalledWith("stop", { serverId: null });
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, saveOutcome: "failed" }),
    );
  });

  it("does not attempt a save when RCON isn't connected, and still proceeds (saveOutcome: 'skipped')", async () => {
    runManagedLifecycle.mockResolvedValue({
      handled: true,
      success: true,
      message: "Container stopped",
    });
    const rconService = { connected: false, save: vi.fn() };
    const response = createResponse();

    await getHandler("/force-stop", "post")(
      { app: makeApp({ rconService, serverManager: {}, io: { emit: vi.fn() } }) },
      response,
    );

    expect(rconService.save).not.toHaveBeenCalled();
    expect(runManagedLifecycle).toHaveBeenCalledWith("stop", { serverId: null });
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, saveOutcome: "skipped" }),
    );
  });

  it("proceeds with the stop when the save never resolves -- the timeout path, exercised for real (saveOutcome: 'timedOut')", async () => {
    vi.useFakeTimers();
    try {
      runManagedLifecycle.mockResolvedValue({
        handled: true,
        success: true,
        message: "Container stopped",
      });
      const rconService = {
        connected: true,
        save: vi.fn(() => new Promise(() => {})),
      };
      const response = createResponse();

      const handlerPromise = getHandler("/force-stop", "post")(
        { app: makeApp({ rconService, serverManager: {}, io: { emit: vi.fn() } }) },
        response,
      );

      await vi.advanceTimersByTimeAsync(3100);
      await handlerPromise;

      expect(runManagedLifecycle).toHaveBeenCalledWith("stop", { serverId: null });
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, saveOutcome: "timedOut" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports saveOutcome even when the stop itself subsequently fails", async () => {
    runManagedLifecycle.mockResolvedValue({
      handled: true,
      success: false,
      error: "docker socket unreachable",
    });
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: true }),
    };
    const response = createResponse();

    await getHandler("/force-stop", "post")(
      { app: makeApp({ rconService, serverManager: {}, io: { emit: vi.fn() } }) },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(502);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ saveOutcome: "saved" }),
    );
  });

  it("applies the same bounded save to the native (non-Docker) branch too -- not a smaller version of the divergence this fixes", async () => {
    runManagedLifecycle.mockResolvedValue({ handled: false });
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: true }),
    };
    const serverManager = {
      stopServer: vi.fn().mockResolvedValue({ success: true, confirmed: true }),
    };
    const response = createResponse();

    await getHandler("/force-stop", "post")(
      { app: makeApp({ rconService, serverManager, io: { emit: vi.fn() } }) },
      response,
    );

    expect(rconService.save).toHaveBeenCalled();
    expect(serverManager.stopServer).toHaveBeenCalledWith(false, { serverId: null });
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, saveOutcome: "saved" }),
    );
  });
});
