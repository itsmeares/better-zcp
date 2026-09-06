import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

const getScheduledTasks = vi.fn();
const updateScheduledTask = vi.fn();
const deleteScheduledTask = vi.fn();

vi.mock("../database/init.js", () => ({
  getScheduledTasks,
  updateScheduledTask,
  deleteScheduledTask,
  getServer: vi.fn(async () => ({ id: "server-b" })),
  getActiveServer: vi.fn(async () => null),
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/scheduler.js");

function getUpdateHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/tasks/:id" && entry.route.methods.put,
  );
  if (!layer) throw new Error("PUT /tasks/:id route not registered");
  return layer.route.stack[0].handle;
}

function getDeleteHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/tasks/:id" && entry.route.methods.delete,
  );
  if (!layer) throw new Error("DELETE /tasks/:id route not registered");
  return layer.route.stack[0].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

describe("scheduled-task update rollback", () => {
  beforeEach(() => {
    getScheduledTasks.mockReset();
    updateScheduledTask.mockReset();
    deleteScheduledTask.mockReset();
  });

  it("restores every previous field when the scheduler rejects the update", async () => {
    const previousTask = {
      id: 7,
      name: "Nightly save",
      cron_expression: "0 */6 * * *",
      command: "save",
      server_id: "server-a",
      enabled: 1,
    };
    getScheduledTasks.mockResolvedValue([previousTask]);
    updateScheduledTask
      .mockImplementationOnce(async (id, name, cron, command, enabled, serverId) => {
        Object.assign(previousTask, {
          name,
          cron_expression: cron,
          command,
          server_id: serverId,
        });
        return previousTask;
      })
      .mockResolvedValueOnce(previousTask);

    const scheduleTask = vi.fn().mockReturnValue(false);
    const response = createResponse();
    await getUpdateHandler()(
      {
        params: { id: "7" },
        body: {
          name: "Broken update",
          cronExpression: "0 12 * * *",
          command: "restart",
          serverId: "server-b",
        },
        user: { role: "admin" },
        app: { get: () => ({ scheduleTask, cancelTask: vi.fn() }) },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(updateScheduledTask).toHaveBeenNthCalledWith(
      2,
      7,
      "Nightly save",
      "0 */6 * * *",
      "save",
      1,
      "server-a",
    );
  });

  it("does not report success or cancel a job when the task does not exist", async () => {
    deleteScheduledTask.mockResolvedValue(false);
    const cancelTask = vi.fn();
    const response = createResponse();

    await getDeleteHandler()(
      {
        params: { id: "404" },
        user: { role: "admin" },
        app: { get: () => ({ cancelTask }) },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      error: "Task not found",
      code: "SCHEDULER_TASK_NOT_FOUND",
    });
    expect(cancelTask).not.toHaveBeenCalled();
  });
});