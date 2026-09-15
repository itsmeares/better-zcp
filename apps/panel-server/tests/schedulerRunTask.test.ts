import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../database/init.ts", () => ({
  getScheduledTasks: vi.fn(),
  createScheduledTask: vi.fn(),
  updateScheduledTask: vi.fn(),
  getServer: vi.fn(),
  getActiveServer: vi.fn().mockResolvedValue(null),
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
  const scheduler = new Scheduler(rconService, serverManager);
  return { scheduler, rconService, serverManager };
}

describe("Scheduler.runTaskNow command dispatch", () => {
  it("routes 'restart' through performRestart, not raw RCON", async () => {
    const { scheduler, rconService } = makeScheduler();
    scheduler.performRestart = vi.fn().mockResolvedValue({ success: true });

    await scheduler.runTaskNow({ id: 1, name: "Restart", command: "restart" });

    expect(scheduler.performRestart).toHaveBeenCalledWith(null, {
      rconService,
      serverManager: expect.any(Object),
    });
    expect(rconService.execute).not.toHaveBeenCalledWith(
      "restart",
      expect.anything(),
    );
  });

  it("routes 'save' through rconService.save()", async () => {
    const { scheduler, rconService } = makeScheduler();

    await scheduler.runTaskNow({ id: 2, name: "Save", command: "save" });

    expect(rconService.save).toHaveBeenCalledWith({ skipLog: true });
  });

  it("routes 'servermsg <text>' through rconService.serverMessage()", async () => {
    const { scheduler, rconService } = makeScheduler();

    await scheduler.runTaskNow({
      id: 3,
      name: "Broadcast",
      command: "servermsg Server restarting soon",
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
      command: `servermsg ${message}`,
    });

    expect(rconService.serverMessage).toHaveBeenCalledWith(message, {
      skipLog: true,
    });
  });

  it("routes 'bridge:<action>' through executeBridgeAction()", async () => {
    const { scheduler } = makeScheduler();
    scheduler.executeBridgeAction = vi.fn().mockResolvedValue();

    await scheduler.runTaskNow({
      id: 4,
      name: "Storm",
      command: "bridge:triggerStorm",
    });

    expect(scheduler.executeBridgeAction).toHaveBeenCalledWith(
      "bridge:triggerStorm",
    );
  });

  it("falls back to a raw RCON command for anything else", async () => {
    const { scheduler, rconService } = makeScheduler();

    await scheduler.runTaskNow({ id: 5, name: "Players", command: "players" });

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
    const task = { id: 7, name: "Restart", command: "restart" };
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
        command: "save",
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
      command: "save",
      enabled: 1,
      server_id: null,
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
      scheduler: new Scheduler(rconService, serverManager),
      rconService,
    };
  }

  beforeEach(() => {
    logScheduleExecution.mockClear();
  });

  it("defaults to 'Auto Restart' when no label is passed (genuinely unattended callers unchanged)", async () => {
    const { scheduler } = makeSchedulerForRestart();

    const result = await scheduler.performRestart();

    expect(result.success).toBe(false);
    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Auto Restart",
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

describe("performRestart(): a serverManager without process-detection must refuse, not silently start", () => {
  it("refuses when getServerProcessDetails is unavailable and RCON cannot confirm the server either way", async () => {
    const rconService = {
      connected: false,
      connect: vi.fn().mockResolvedValue(),
      execute: vi
        .fn()
        .mockResolvedValue({ success: false, error: "not connected" }),
    };
    const serverManager = {
      _serverId: null,
      checkServerRunning: vi.fn().mockResolvedValue(false),
      startServer: vi.fn().mockResolvedValue({ success: true }),
    };
    const scheduler = new Scheduler(rconService, serverManager);

    const result = await scheduler.performRestart();

    expect(result.success).toBe(false);
    expect(result.message).toMatch(
      /could not confirm whether the server is stopped/i,
    );
    expect(serverManager.startServer).not.toHaveBeenCalled();
    expect(serverManager.checkServerRunning).not.toHaveBeenCalled();
  });
});

describe("POST /api/scheduler/restart-now labels its Schedule History entry as manual", () => {
  function getRestartNowHandler() {
    const layer = router.stack.find(
      (entry) =>
        entry.route?.path === "/restart-now" && entry.route.methods.post,
    );
    return layer.route.stack[0].handle;
  }

  it("calls scheduler.performRestart with label: 'Manual restart'", async () => {
    const { getActiveServer } = await import("../database/init.ts");
    getActiveServer.mockResolvedValue(null);
    const performRestart = vi.fn().mockResolvedValue({ success: true });
    const response = createResponse();

    await getRestartNowHandler()(
      {
        user: { role: "automation_and_control" },
        body: { warningMinutes: 5 },
        app: { get: () => ({ performRestart }) },
      },
      response,
    );

    expect(performRestart).toHaveBeenCalledWith(5, { label: "Manual restart" });
  });
});

describe("PUT /api/scheduler/restart-warning", () => {
  function getRestartWarningHandler() {
    const layer = router.stack.find(
      (entry) =>
        entry.route?.path === "/restart-warning" && entry.route.methods.put,
    );
    return layer.route.stack[0].handle;
  }

  it("persists the submitted warning settings through Scheduler", async () => {
    const setRestartWarning = vi.fn().mockResolvedValue({
      locale: "zh-CN",
      template: "将在 {count}{unit} 后重启",
    });
    const response = createResponse();

    await getRestartWarningHandler()(
      {
        body: { locale: "zh-CN", template: "将在 {count}{unit} 后重启" },
        app: { get: () => ({ setRestartWarning }) },
      },
      response,
    );

    expect(setRestartWarning).toHaveBeenCalledWith({
      locale: "zh-CN",
      template: "将在 {count}{unit} 后重启",
    });
    expect(response.json).toHaveBeenCalledWith({
      success: true,
      restartWarning: {
        locale: "zh-CN",
        template: "将在 {count}{unit} 后重启",
      },
    });
  });
});
