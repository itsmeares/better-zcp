import { describe, expect, it, vi } from "vitest";

const logServerEvent = vi.fn();

vi.mock("../database/init.js", () => ({
  logServerEvent,
}));

const { logServerEventBestEffort } = await import("../routes/server.js");

describe("server event logging", () => {
  it("does not turn a completed operation into a rejected request when logging fails", async () => {
    logServerEvent.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      logServerEventBestEffort("server_stop", "Server stopped via web UI"),
    ).resolves.toBeUndefined();
  });
});
