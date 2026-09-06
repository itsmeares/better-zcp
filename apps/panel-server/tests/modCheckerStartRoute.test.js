import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode } from "../utils/errorCodes.js";

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
}));

const { default: router } = await import("../routes/mods.js");

function getStartHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/start" && entry.route.methods.post,
  );
  if (!layer) throw new Error("POST /start route not registered");
  return layer.route.stack[0].handle;
}

function getRestartOptionsHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/restart-options" && entry.route.methods.put,
  );
  if (!layer) throw new Error("PUT /restart-options route not registered");
  return layer.route.stack.at(-1).handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

describe("POST /mods/start", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports a failed start when the checker has no usable Workshop ACF path", async () => {
    const response = createResponse();
    const start = vi.fn(() => false);

    await getStartHandler()(
      { app: { get: () => ({ start }) } },
      response,
    );

    expect(start).toHaveBeenCalledOnce();
    expect(response.status).toHaveBeenCalledWith(400);
    // Every sibling 400 in this file (interval, auto-restart, ...) carries a
    // `code` alongside its message; this one didn't -- verified live that it
    // was still missing before this test was updated.
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: expect.stringMatching(/could not start/i),
      code: ErrorCode.MODS_START_ACF_PATH_NOT_SET,
    });
  });

  it("reports success only after the checker starts", async () => {
    const response = createResponse();
    const start = vi.fn(() => true);

    await getStartHandler()(
      { app: { get: () => ({ start }) } },
      response,
    );

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({
      success: true,
      message: "Mod checker started",
    });
  });
});

describe("PUT /mods/restart-options", () => {
  it("rejects a warning delay above the service limit instead of clamping it", async () => {
    const setRestartOptions = vi.fn();
    const response = createResponse();

    await getRestartOptionsHandler()(
      {
        body: { warningMinutes: 31 },
        app: { get: () => ({ setRestartOptions }) },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(setRestartOptions).not.toHaveBeenCalled();
  });

  it("rejects a max delay below the service minimum", async () => {
    const setRestartOptions = vi.fn();
    const response = createResponse();

    await getRestartOptionsHandler()(
      {
        body: { maxDelayMinutes: 4 },
        app: { get: () => ({ setRestartOptions }) },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(setRestartOptions).not.toHaveBeenCalled();
  });

  it("rejects whitespace and scientific-notation delays", async () => {
    for (const body of [{ warningMinutes: " " }, { maxDelayMinutes: "1e2" }]) {
      const setRestartOptions = vi.fn();
      const response = createResponse();

      await getRestartOptionsHandler()(
        { body, app: { get: () => ({ setRestartOptions }) } },
        response,
      );

      expect(response.status).toHaveBeenCalledWith(400);
      expect(setRestartOptions).not.toHaveBeenCalled();
    }
  });
});