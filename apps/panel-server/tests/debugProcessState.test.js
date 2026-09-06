import { describe, expect, it, vi } from "vitest";
import { getServerProcessState } from "../routes/debug.js";

describe("debug server process state", () => {
  it("preserves an unknown state when process detection reports scanFailed", async () => {
    const state = await getServerProcessState(
      {
        getServerProcessDetails: vi.fn(async () => ({
          running: false,
          scanFailed: true,
        })),
      },
      20,
    );

    expect(state).toEqual({ running: null, scanFailed: true });
  });

  it("performs one authoritative process scan per request", async () => {
    const getServerProcessDetails = vi.fn(async () => ({
      running: true,
      scanFailed: false,
    }));

    await expect(
      getServerProcessState({ getServerProcessDetails }, 20),
    ).resolves.toEqual({ running: true, scanFailed: false });
    expect(getServerProcessDetails).toHaveBeenCalledOnce();
  });

  it("returns unknown when a legacy boolean check times out", async () => {
    const state = await getServerProcessState(
      {
        checkServerRunning: () => new Promise(() => {}),
      },
      1,
    );

    expect(state).toEqual({ running: null, scanFailed: true });
  });
});