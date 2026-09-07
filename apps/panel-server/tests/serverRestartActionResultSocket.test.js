import { describe, expect, it, vi } from "vitest";


vi.mock("../database/init.ts", () => ({
  getActiveServer: vi.fn(async () => ({ isRemote: false })),
}));

const { default: router } = await import("../routes/server.js");

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

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe("POST /server/restart -- scheduler:action_result socket emission", () => {
  it("emits the real outcome after performRestart resolves, distinct from the immediate accept response", async () => {
    const emit = vi.fn();
    const performRestart = vi.fn().mockResolvedValue({
      success: false,
      message: "Could not confirm whether the server is stopped",
    });
    const response = createResponse();

    await getHandler("/restart", "post")(
      {
        body: { warningMinutes: 5 },
        app: {
          get: (key) =>
            key === "scheduler" ? { performRestart } : key === "io" ? { emit } : null,
        },
      },
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );

    await flushMicrotasks();

    expect(emit).toHaveBeenCalledWith("scheduler:action_result", {
      kind: "restart",
      success: false,
      message: "Could not confirm whether the server is stopped",
    });
  });

  it("emits success when performRestart actually succeeds", async () => {
    const emit = vi.fn();
    const performRestart = vi.fn().mockResolvedValue({ success: true, message: "Restarted successfully" });
    const response = createResponse();

    await getHandler("/restart", "post")(
      {
        body: {},
        app: {
          get: (key) =>
            key === "scheduler" ? { performRestart } : key === "io" ? { emit } : null,
        },
      },
      response,
    );
    await flushMicrotasks();

    expect(emit).toHaveBeenCalledWith("scheduler:action_result", {
      kind: "restart",
      success: true,
      message: "Restarted successfully",
    });
  });

  it("rejects a second restart while the first accepted restart is still running", async () => {
    let finishRestart;
    const performRestart = vi.fn(
      () => new Promise((resolve) => {
        finishRestart = resolve;
      }),
    );
    const app = {
      get: (key) =>
        key === "scheduler" ? { performRestart } : key === "io" ? { emit: vi.fn() } : null,
    };
    const firstResponse = createResponse();

    try {
      await getHandler("/restart", "post")({ body: {}, app }, firstResponse);
      expect(performRestart).toHaveBeenCalledWith(
        5,
        expect.objectContaining({ lifecycleLock: expect.any(Object) }),
      );

      const secondResponse = createResponse();
      await getHandler("/restart", "post")({ body: {}, app }, secondResponse);

      expect(secondResponse.status).toHaveBeenCalledWith(409);
      expect(secondResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "SERVER_LIFECYCLE_IN_PROGRESS" }),
      );
      expect(performRestart).toHaveBeenCalledOnce();
    } finally {
      finishRestart?.({ success: true, message: "Restarted successfully" });
      await flushMicrotasks();
    }
  });

  it("emits failure if performRestart itself throws", async () => {
    const emit = vi.fn();
    const performRestart = vi.fn().mockRejectedValue(new Error("unexpected crash"));
    const response = createResponse();

    await getHandler("/restart", "post")(
      {
        body: {},
        app: {
          get: (key) =>
            key === "scheduler" ? { performRestart } : key === "io" ? { emit } : null,
        },
      },
      response,
    );
    await flushMicrotasks();

    expect(emit).toHaveBeenCalledWith("scheduler:action_result", {
      kind: "restart",
      success: false,
      message: "unexpected crash",
    });
  });

  it("does not throw when app.get('io') returns something without a real emit function", async () => {
    const performRestart = vi.fn().mockResolvedValue({ success: true, message: "ok" });
    const response = createResponse();

    await expect(
      getHandler("/restart", "post")(
        { body: {}, app: { get: () => ({ performRestart }) } }, // same object for every key, no .emit
        response,
      ),
    ).resolves.not.toThrow();
    await expect(flushMicrotasks()).resolves.not.toThrow();
  });
});
