import { scopedTests } from "./helpers/serverScope.ts";
const it = scopedTests("server-a");
import { beforeEach, describe, expect, vi } from "vite-plus/test";

const { logInfo } = vi.hoisted(() => ({ logInfo: vi.fn() }));

vi.mock("../utils/logger.ts", () => ({
  createLogger: () => ({ debug: vi.fn(), info: logInfo, warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../database/init.ts", () => ({
  getScheduledTasks: vi.fn(),
  createScheduledTask: vi.fn(),
  updateScheduledTask: vi.fn(),
  getServer: vi.fn(),
  getCurrentServer: vi.fn().mockResolvedValue(null),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: vi.fn().mockResolvedValue(),
  logPlayerAction: vi.fn().mockResolvedValue(),
  recordPlayerSession: vi.fn().mockResolvedValue(),
}));

const { Scheduler } = await import("../services/scheduler.ts");
const { getScheduledTasks, createScheduledTask, logScheduleExecution } =
  await import("../database/init.ts");
const { default: router, parseTaskId } = await import("../routes/scheduler.ts");

function makeScheduler() {
  const rconService = {
    connected: true,
    execute: vi.fn().mockResolvedValue({ success: true }),
    save: vi.fn().mockResolvedValue({ success: true }),
    serverMessage: vi.fn().mockResolvedValue({ success: true }),
  };
  const serverManager = { _serverId: null };
  const scheduler = new Scheduler(rconService, serverManager, { active: null, cancel: () => false, run: async () => ({ success: true }) });
  return { scheduler, rconService, serverManager };
}

describe("Scheduler.runTaskNow command dispatch", () => {
  it("routes 'restart' through performRestart, not raw RCON", async () => {
    const { scheduler, rconService } = makeScheduler();
    scheduler.performRestart = vi.fn().mockResolvedValue({ success: true });

    await scheduler.runTaskNow({ id: 1, name: "Restart", server_id: "server-a", command: "restart" });

    expect(scheduler.performRestart).toHaveBeenCalledWith(null, {
      rconService,
      serverManager: expect.any(Object),
      onlyWhenEmpty: true,
    });
    expect(rconService.execute).not.toHaveBeenCalledWith(
      "restart",
      expect.anything(),
    );
  });

  it("records a failed restart as a failed scheduled task", async () => {
    const { scheduler } = makeScheduler();
    scheduler.performRestart = vi.fn().mockResolvedValue({ success: false, message: "World save failed" });

    const result = await scheduler.runTaskNow({ id: 99, name: "Restart", server_id: "server-a", command: "restart" });

    expect(result).toEqual({ success: false, message: "World save failed" });
    expect(logScheduleExecution).toHaveBeenCalledWith(
      99, "Restart", "restart", false, "World save failed", expect.any(Number),
    );
  });

  it("does not retry a deferred restart before the next scheduled run", async () => {
    vi.useFakeTimers();
    try {
      const { scheduler } = makeScheduler();
      scheduler.performRestart = vi.fn().mockResolvedValue({ success: false, deferred: true, message: "Waiting window expired" });
      await scheduler.runTaskNow({ id: 100, name: "Restart", server_id: "server-a", command: "restart" });
      await vi.advanceTimersByTimeAsync(120000);
      expect(scheduler.performRestart).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("routes 'save' through rconService.save()", async () => {
    const { scheduler, rconService } = makeScheduler();

    await scheduler.runTaskNow({ id: 2, name: "Save", server_id: "server-a", command: "save" });

    expect(rconService.save).toHaveBeenCalledWith({ skipLog: true });
  });

  it("routes 'servermsg <text>' through rconService.serverMessage()", async () => {
    const { scheduler, rconService } = makeScheduler();

    await scheduler.runTaskNow({
      id: 3,
      name: "Broadcast",
      server_id: "server-a", command: "servermsg Server restarting soon",
    });

    expect(rconService.serverMessage).toHaveBeenCalledWith(
      "Server restarting soon",
      { skipLog: true },
    );
  });

  it("preserves Chinese text when routing a scheduled server message", async () => {
    const { scheduler, rconService } = makeScheduler();
    const message =
      "\u670d\u52a1\u5668\u5c06\u5728\u4e94\u5206\u949f\u540e\u91cd\u542f";

    await scheduler.runTaskNow({
      id: 31,
      name: "Broadcast",
      server_id: "server-a", command: `servermsg ${message}`,
    });

    expect(rconService.serverMessage).toHaveBeenCalledWith(message, {
      skipLog: true,
    });
  });

  it("keeps saved bridge tasks unsupported and never dispatches them to RCON", async () => {
    const { scheduler, rconService } = makeScheduler();
    expect(scheduler.scheduleTask({
      id: 4,
      name: "World save",
      server_id: "server-a", command: "bridge:saveWorld",
      cron_expression: "0 * * * *", enabled: 1,
    })).toBe(false);

    expect(await scheduler.runTaskNow({
      id: 4,
      name: "World save",
      server_id: "server-a", command: "bridge:saveWorld",
    })).toEqual({ success: false, message: "Unsupported scheduled task command" });
    expect(rconService.execute).not.toHaveBeenCalled();
  });

  it("falls back to a raw RCON command for anything else", async () => {
    const { scheduler, rconService } = makeScheduler();

    await scheduler.runTaskNow({ id: 5, name: "Players", server_id: "server-a", command: "players" });

    expect(rconService.execute).toHaveBeenCalledWith("players", {
      skipLog: true,
    });
  });
});

function getRunNowHandler() {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === "/tasks/:id/run" && entry.route.methods.post,
  );
  return layer.route.stack[0].handle;
}

function getUpdateHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/tasks/:id" && entry.route.methods.put,
  );
  return layer.route.stack[0].handle;
}

function getCreateHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/tasks" && entry.route.methods.post,
  );
  return layer.route.stack[0].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

describe("POST /api/scheduler/tasks/:id/run", () => {
  let runTaskNow;

  beforeEach(() => {
    runTaskNow = vi.fn().mockResolvedValue();
    getScheduledTasks.mockReset();
  });

  it("triggers the matching task through scheduler.runTaskNow()", async () => {
    const task = { id: 7, name: "Restart", server_id: "server-a", command: "restart" };
    getScheduledTasks.mockResolvedValue([task]);
    const app = { get: vi.fn().mockReturnValue({ runTaskNow }) };
    const response = createResponse();

    await getRunNowHandler()(
      { app, user: { role: "automation_and_control" }, params: { id: "7" } },
      response,
    );

    expect(runTaskNow).toHaveBeenCalledWith(task);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("returns 404 for a task id that doesn't exist", async () => {
    getScheduledTasks.mockResolvedValue([]);
    const app = { get: vi.fn().mockReturnValue({ runTaskNow }) };
    const response = createResponse();

    await getRunNowHandler()({ app, params: { id: "999" } }, response);

    expect(runTaskNow).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(404);
  });

  it("does not manually run a saved weather task", async () => {
    getScheduledTasks.mockResolvedValue([{ id: 7, name: "Old weather", server_id: "server-a", command: "bridge:triggerStorm" }]);
    const app = { get: vi.fn().mockReturnValue({ runTaskNow }) };
    const response = createResponse();

    await getRunNowHandler()({ app, params: { id: "7" } }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(runTaskNow).not.toHaveBeenCalled();
  });

  it("rejects a task ID with a numeric prefix instead of truncating it", async () => {
    getScheduledTasks.mockResolvedValue([]);
    const response = createResponse();
    await getRunNowHandler()(
      { app: { get: vi.fn() }, params: { id: "7junk" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(getScheduledTasks).not.toHaveBeenCalled();
  });
});

describe("POST /api/scheduler/tasks logging", () => {
  it("redacts a raw RCON adduser password before logging the task", async () => {
    const { createScheduledTask } = await import("../database/init.ts");
    const secret = "hunter2-scheduled-password";
    createScheduledTask.mockResolvedValue({ id: 42 });
    logInfo.mockClear();
    const response = createResponse();

    await getCreateHandler()(
      {
        body: {
          name: "Add player",
          cronExpression: "0 * * * *",
          command: `adduser "Bob" "${secret}"`,
        },
        app: { get: () => ({ scheduleTask: vi.fn().mockReturnValue({ scheduled: true }) }) },
      },
      response,
    );

    expect(logInfo).toHaveBeenCalledOnce();
    expect(logInfo.mock.calls[0][0]).toContain('adduser "Bob" "[REDACTED]"');
    expect(logInfo.mock.calls[0][0]).not.toContain(secret);
  });
});

describe("scheduler request body validation", () => {
  it("returns 400 for a missing create body", async () => {
    const response = createResponse();

    await getCreateHandler()(
      { body: null, app: { get: () => ({}) } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
  });

  it("returns 400 for a missing cron-preview body", async () => {
    const layer = router.stack.find(
      (entry) =>
        entry.route?.path === "/validate-cron" && entry.route.methods.post,
    );
    const response = createResponse();

    await layer.route.stack[0].handle({ body: null }, response);

    expect(response.status).toHaveBeenCalledWith(400);
  });
});

describe("scheduler task ID parsing", () => {
  it("accepts legacy numeric IDs and rejects malformed values", () => {
    expect(parseTaskId(" 7 ")).toBe(7);
    expect(parseTaskId("7junk")).toBeNull();
    expect(parseTaskId("1.5")).toBeNull();
  });
});

describe("unattended schedule frequency validation", () => {
  it("does not schedule a persisted every-minute task", () => {
    const { scheduler } = makeScheduler();

    expect(
      scheduler.scheduleTask({
        id: 10,
        name: "Too frequent",
        cron_expression: "* * * * *",
        server_id: "server-a", command: "save",
      }),
    ).toBe(false);
    expect(scheduler.jobs.size).toBe(0);
  });

  it("does not schedule a persisted every-minute backup", async () => {
    const { scheduler } = makeScheduler();
    scheduler.setBackupService({
      getSettings: vi.fn().mockResolvedValue({
        enabled: true,
        schedule: "* * * * *",
        includeDb: false,
      }),
    });

    await scheduler.setupBackupSchedule();

    expect(scheduler.backupJob).toBeNull();
  });

  it("does not schedule an every-minute environment auto-restart", () => {
    const originalEnabled = process.env.AUTO_RESTART_ENABLED;
    const originalCron = process.env.AUTO_RESTART_CRON;
    process.env.AUTO_RESTART_ENABLED = "true";
    process.env.AUTO_RESTART_CRON = "* * * * *";

    try {
      const { scheduler } = makeScheduler();
      scheduler.setupAutoRestart();
      expect(scheduler.autoRestartJob).toBeNull();
    } finally {
      if (originalEnabled === undefined)
        delete process.env.AUTO_RESTART_ENABLED;
      else process.env.AUTO_RESTART_ENABLED = originalEnabled;
      if (originalCron === undefined) delete process.env.AUTO_RESTART_CRON;
      else process.env.AUTO_RESTART_CRON = originalCron;
    }
  });
});

describe("PUT /api/scheduler/tasks/:id", () => {
  it("keeps an enabled task scheduled when enabled is omitted", async () => {
    const { updateScheduledTask } = await import("../database/init.ts");
    const scheduleTask = vi.fn();
    const cancelTask = vi.fn();
    updateScheduledTask.mockResolvedValue({
      id: 8,
      name: "Renamed task",
      cron_expression: "0 * * * *",
      server_id: "server-a", command: "save",
      enabled: 1,

    });
    const response = createResponse();

    await getUpdateHandler()(
      {
        params: { id: "8" },
        body: { name: "Renamed task" },
        app: { get: () => ({ scheduleTask, cancelTask }) },
      },
      response,
    );

    expect(scheduleTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 8, enabled: 1 }),
    );
    expect(cancelTask).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("rejects stringified enabled values instead of treating false as true", async () => {
    const { updateScheduledTask } = await import("../database/init.ts");
    updateScheduledTask.mockClear();
    const response = createResponse();

    await getUpdateHandler()(
      {
        params: { id: "8" },
        body: { enabled: "false" },
        app: { get: () => ({ scheduleTask: vi.fn(), cancelTask: vi.fn() }) },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(updateScheduledTask).not.toHaveBeenCalled();
  });
});

describe("performRestart() Schedule History labeling", () => {
  function makeSchedulerForRestart() {
    const rconService = {
      connected: true,
      connect: vi.fn().mockResolvedValue(),
      execute: vi
        .fn()
        .mockResolvedValue({ success: false, error: "RCON unavailable" }),
    };
    const serverManager = {
      _serverId: null,
      checkServerRunning: vi.fn().mockResolvedValue(true), // wasRunning=true -> skips the 10s "wait and start" path
    };
    return {
      scheduler: new Scheduler(rconService, serverManager, { active: null, cancel: () => false, run: async () => ({ success: false, message: "RCON not available" }) }),
      rconService,
    };
  }

  beforeEach(() => {
    logScheduleExecution.mockClear();
  });

  it("uses the default restart label when no label is passed", async () => {
    const { scheduler } = makeSchedulerForRestart();

    const result = await scheduler.performRestart();

    expect(result.success).toBe(false);
    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Restart",
      "restart",
      false,
      expect.stringContaining("RCON not available"),
      expect.any(Number),
    );
  });

  it("uses the caller-supplied label instead", async () => {
    const { scheduler } = makeSchedulerForRestart();

    await scheduler.performRestart(null, { label: "Manual restart" });

    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Manual restart",
      "restart",
      false,
      expect.stringContaining("RCON not available"),
      expect.any(Number),
    );
  });
});
