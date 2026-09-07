import { afterEach, describe, expect, it, vi } from "vitest";

const logServerEventMock = vi.fn(async () => ({}));
vi.mock("../database/init.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, logServerEvent: logServerEventMock };
});

const { checkServerStatusNow, io } = await import("../index.ts");
const { ServerManager } = await import("../services/serverManager.ts");
const { onLog } = await import("../utils/logger.ts");

describe("checkServerStatusNow(detectionReason) -- the reason reaches both transition messages", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("interpolates a custom detectionReason into both the 'state changed' log line and the persisted stop event, on a real stop transition", async () => {
    const emitSpy = vi.spyOn(io, "emit").mockImplementation(() => {});
    const logEntries = [];
    const unsubscribe = onLog((entry) => logEntries.push(entry));
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    const scanSpy = vi.spyOn(ServerManager.prototype, "getServerProcessDetails");

    try {
      scanSpy.mockResolvedValue({ running: true, scanFailed: false });
      await checkServerStatusNow("seed");
      await flush();
      expect(emitSpy).not.toHaveBeenCalled();

      emitSpy.mockClear();
      logEntries.length = 0;
      logServerEventMock.mockClear();
      scanSpy.mockResolvedValue({ running: false, scanFailed: false });
      await checkServerStatusNow("integration-test-reason");
      await flush();

      expect(emitSpy).toHaveBeenCalledWith("server:status", {
        running: false,
        state: "stopped",
      });
      const stateChangedLog = logEntries.find((e) =>
        e.message.includes("Server state changed"),
      );
      expect(stateChangedLog).toBeDefined();
      expect(stateChangedLog.message).toContain("(detected by integration-test-reason)");

      expect(logServerEventMock).toHaveBeenCalledWith(
        "server_stop",
        expect.stringContaining("(detected by integration-test-reason)"),
      );
    } finally {
      unsubscribe();
    }
  });
});
