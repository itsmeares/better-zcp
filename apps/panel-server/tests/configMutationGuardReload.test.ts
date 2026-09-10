import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveServer = vi.fn();

vi.mock("../database/init.ts", () => ({ getActiveServer }));

const {
  requireStoppedForLocalConfigMutation,
  warnRunningForLocalConfigEdit,
} = await import("../services/configMutationGuard.ts");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function buildServerManager(reloadThrows = false) {
  const callOrder: string[] = [];
  return {
    callOrder,
    serverManager: {
      reloadConfig: vi.fn(async () => {
        callOrder.push("reloadConfig");
        if (reloadThrows) throw new Error("reload failed");
      }),
      getServerProcessDetails: vi.fn(async () => {
        callOrder.push("getServerProcessDetails");
        return { running: false, scanFailed: false };
      }),
    },
  };
}

beforeEach(() => {
  getActiveServer.mockReset().mockResolvedValue({ isRemote: false });
});

describe("config mutation guards reload the active server before trusting process state", () => {
  it("reloads before the fail-closed guard checks whether the server is stopped", async () => {
    const { callOrder, serverManager } = buildServerManager();
    const next = vi.fn();

    await requireStoppedForLocalConfigMutation(
      { app: { get: () => serverManager } },
      createResponse(),
      next,
    );

    expect(callOrder).toEqual(["reloadConfig", "getServerProcessDetails"]);
    expect(next).toHaveBeenCalledOnce();
  });

  it("fails closed when reloadConfig fails and never trusts the stale process check", async () => {
    const { callOrder, serverManager } = buildServerManager(true);
    const response = createResponse();
    const next = vi.fn();

    await requireStoppedForLocalConfigMutation(
      { app: { get: () => serverManager } },
      response,
      next,
    );

    expect(callOrder).toEqual(["reloadConfig"]);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("keeps ordinary edits non-blocking while still reloading before the warning check", async () => {
    const { callOrder, serverManager } = buildServerManager();
    const request = { app: { get: () => serverManager } };
    const next = vi.fn();

    await warnRunningForLocalConfigEdit(request, createResponse(), next);

    expect(callOrder).toEqual(["reloadConfig", "getServerProcessDetails"]);
    expect(request.configEditRestartWarning).toBe(false);
    expect(next).toHaveBeenCalledOnce();
  });

  it("warns instead of blocking ordinary edits when reloadConfig fails", async () => {
    const { callOrder, serverManager } = buildServerManager(true);
    const request = { app: { get: () => serverManager } };
    const response = createResponse();
    const next = vi.fn();

    await warnRunningForLocalConfigEdit(request, response, next);

    expect(callOrder).toEqual(["reloadConfig"]);
    expect(response.status).not.toHaveBeenCalled();
    expect(request.configEditRestartWarning).toBe(true);
    expect(next).toHaveBeenCalledOnce();
  });
});
