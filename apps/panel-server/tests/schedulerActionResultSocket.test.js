import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-08-26 bug hunt, scheduler blind-success family: POST /restart-now and
// POST /tasks/:id/run both used to run their real action fire-and-forget
// (only a server-side log on failure) and answer {success:true} regardless
// of what actually happened -- a genuine failure was swallowed, discoverable
// only by someone who thought to check Schedule History. Both already
// compute a real {success, message} internally and already log it to
// Schedule History (logScheduleExecution) on every path; the gap was that
// nothing surfaced it to the client. Fixed by emitting 'scheduler:action_result'
// over the socket once the underlying promise resolves, in addition to (not
// instead of) the immediate "accepted" response.

// "save" (the command every /tasks/:id/run test below uses) requires
// server.control -- see requiredCapabilityForScheduledCommand in
// services/scheduler.js -- so the mock role needs it to clear the
// permission check and reach the socket-emission behavior under test.
const ROLES = {
  automation_and_control: {
    name: "automation_and_control",
    capabilities: ["automation.manage", "server.control"],
  },
};

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn(),
  getActiveServer: vi.fn().mockResolvedValue(null),
  logScheduleExecution: vi.fn().mockResolvedValue(),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  getRoleByName: vi.fn((name) => Promise.resolve(ROLES[name] || null)),
}));

const { getScheduledTasks, getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/scheduler.js");
const { Scheduler } = await import("../services/scheduler.js");

describe("Scheduler.runTaskNow return value", () => {
  it("returns {success:true, message} on success -- previously undefined on every path", async () => {
    const rconService = { connected: true, save: vi.fn().mockResolvedValue({ success: true }) };
    const scheduler = new Scheduler(rconService, { _serverId: null });

    const result = await scheduler.runTaskNow({ id: 1, name: "Save", command: "save" });

    expect(result).toEqual({ success: true, message: "Completed successfully" });
  });

  it("returns {success:false, message} on failure instead of swallowing it into undefined", async () => {
    const rconService = {
      connected: true,
      save: vi.fn().mockRejectedValue(new Error("world save failed")),
    };
    const scheduler = new Scheduler(rconService, { _serverId: null });

    const result = await scheduler.runTaskNow({ id: 2, name: "Save", command: "save" });

    expect(result).toEqual({ success: false, message: "world save failed" });
  });
});

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[0].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

// Waits out the microtask queue so a fire-and-forget .then()/.catch() chain
// (which the route never awaits before responding) has settled before
// assertions run.
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe("scheduler:action_result socket emission", () => {
  beforeEach(() => {
    getActiveServer.mockResolvedValue(null);
  });

  it("POST /restart-now emits the real outcome after performRestart resolves, distinct from the immediate response", async () => {
    const emit = vi.fn();
    const performRestart = vi.fn().mockResolvedValue({
      success: false,
      message: "Could not confirm whether the server is stopped",
    });
    const response = createResponse();

    await getHandler("/restart-now", "post")(
      {
        user: { role: "automation_and_control" },
        body: { warningMinutes: 5 },
        app: { get: (key) => (key === "scheduler" ? { performRestart } : key === "io" ? { emit } : null) },
      },
      response,
    );

    // The immediate HTTP response only confirms acceptance -- unchanged.
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, message: "Restart initiated" }),
    );

    await flushMicrotasks();

    expect(emit).toHaveBeenCalledWith("scheduler:action_result", {
      kind: "restart",
      success: false,
      message: "Could not confirm whether the server is stopped",
    });
  });

  it("POST /restart-now emits success when performRestart actually succeeds", async () => {
    const emit = vi.fn();
    const performRestart = vi.fn().mockResolvedValue({ success: true, message: "Restarted successfully" });
    const response = createResponse();

    await getHandler("/restart-now", "post")(
      {
        user: { role: "automation_and_control" },
        body: {},
        app: { get: (key) => (key === "scheduler" ? { performRestart } : key === "io" ? { emit } : null) },
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

  it("POST /restart-now emits failure if performRestart itself throws", async () => {
    const emit = vi.fn();
    const performRestart = vi.fn().mockRejectedValue(new Error("unexpected crash"));
    const response = createResponse();

    await getHandler("/restart-now", "post")(
      {
        user: { role: "automation_and_control" },
        body: {},
        app: { get: (key) => (key === "scheduler" ? { performRestart } : key === "io" ? { emit } : null) },
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

  // bug-hunt-2026-08-26 backlog, dispatched 2026-08-27 (Jim's ranked #2):
  // the operator could type a custom restart-warning time above the
  // server's 60-minute cap, and the immediate response never said the
  // value was substituted -- the client's toast just echoed back whatever
  // was typed. Fixed by reporting the value actually used, not just the
  // raw request, so the client can tell the operator when/what it clamped.
  it("POST /restart-now reports the clamped value, not the raw request, when the operator's warningMinutes exceeds the 60-minute cap", async () => {
    const emit = vi.fn();
    const performRestart = vi.fn().mockResolvedValue({ success: true, message: "Restarted successfully" });
    const response = createResponse();

    await getHandler("/restart-now", "post")(
      {
        user: { role: "automation_and_control" },
        body: { warningMinutes: 500 },
        app: { get: (key) => (key === "scheduler" ? { performRestart } : key === "io" ? { emit } : null) },
      },
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, warningMinutes: 60 }),
    );
    expect(performRestart).toHaveBeenCalledWith(60, expect.anything());
  });

  it("POST /restart-now reports the request value unchanged when it's already within the 60-minute cap", async () => {
    const emit = vi.fn();
    const performRestart = vi.fn().mockResolvedValue({ success: true, message: "Restarted successfully" });
    const response = createResponse();

    await getHandler("/restart-now", "post")(
      {
        user: { role: "automation_and_control" },
        body: { warningMinutes: 20 },
        app: { get: (key) => (key === "scheduler" ? { performRestart } : key === "io" ? { emit } : null) },
      },
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, warningMinutes: 20 }),
    );
    expect(performRestart).toHaveBeenCalledWith(20, expect.anything());
  });

  it("does not throw when app.get('io') returns something without a real emit function (defends the existing simplified test mocks elsewhere)", async () => {
    const performRestart = vi.fn().mockResolvedValue({ success: true, message: "ok" });
    const response = createResponse();

    await expect(
      getHandler("/restart-now", "post")(
        { user: { role: "automation_and_control" }, body: {}, app: { get: () => ({ performRestart }) } }, // same object for every key, no .emit
        response,
      ),
    ).resolves.not.toThrow();
    await expect(flushMicrotasks()).resolves.not.toThrow();
  });

  it("POST /tasks/:id/run emits the real outcome, including the task name", async () => {
    const emit = vi.fn();
    const task = { id: 3, name: "Nightly save", command: "save" };
    getScheduledTasks.mockResolvedValue([task]);
    const runTaskNow = vi.fn().mockResolvedValue({ success: false, message: "RCON not connected" });
    const response = createResponse();

    await getHandler("/tasks/:id/run", "post")(
      {
        params: { id: "3" },
        user: { role: "automation_and_control" },
        app: { get: (key) => (key === "scheduler" ? { runTaskNow } : key === "io" ? { emit } : null) },
      },
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, message: "Task triggered" }),
    );
    await flushMicrotasks();

    expect(emit).toHaveBeenCalledWith("scheduler:action_result", {
      kind: "task",
      taskName: "Nightly save",
      success: false,
      message: "RCON not connected",
    });
  });
});
