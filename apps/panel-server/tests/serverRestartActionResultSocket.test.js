import { describe, expect, it, vi } from "vitest";

// 2026-08-26 bug hunt, scheduler blind-success family, third site: POST
// /server/restart (this file) is a SECOND, independent client entry point
// to the exact same scheduler.performRestart() call that scheduler.js's
// POST /restart-now already had fixed earlier tonight -- Dashboard's
// Restart and Restart Now buttons hit THIS route (serverApi.restart),
// while only the Scheduler page's own restart control hit the already-fixed
// one (schedulerApi.restartNow). This route still reported success:true as
// soon as the restart was ACCEPTED, regardless of what performRestart()
// actually resolved to. Fixed by reusing scheduler.js's own
// emitActionResult() helper (now exported) so both entry points emit the
// identical 'scheduler:action_result' event Layout.tsx already listens for
// globally -- no client-side change needed for this route to start working.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => ({ isRemote: false })),
}));

const { default: router } = await import("../routes/server.js");

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  // requirePermission is applied inline per-route in server.js, so the real
  // handler is the LAST entry in this route's middleware stack, not the
  // first (unlike scheduler.js, which applies it once at the router level).
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

    // The immediate HTTP response only confirms acceptance -- unchanged.
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
