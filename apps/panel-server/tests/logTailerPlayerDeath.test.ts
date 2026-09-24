import { describe, expect, it, vi } from "vite-plus/test";
import { LogTailer } from "../services/logTailer.ts";

describe("LogTailer player deaths", () => {
  it("emits a complete death split across log reads", () => {
    const tailer = new LogTailer();
    const deaths: unknown[] = [];
    tailer.on("playerDeath", (death) => deaths.push(death));

    tailer.processUserLogData("user Alice died at (10,-20,");
    tailer.processUserLogData("0) (pvp)\n");

    expect(deaths).toEqual([
      expect.objectContaining({
        player: "Alice",
        x: 10,
        y: -20,
        z: 0,
        pvp: true,
        location: "10,-20,0",
      }),
    ]);
  });

  it("retries log-path discovery before looking for the latest user log", async () => {
    const tailer = new LogTailer();
    const findLogPath = vi.spyOn(tailer, "findLogPath").mockImplementation(async () => {
      tailer.logsDir = "/tmp/zomboid-logs";
    });
    const findLatestUserLog = vi
      .spyOn(tailer as any, "findLatestUserLog")
      .mockImplementation(() => {});

    await tailer.checkUserLog();

    expect(findLogPath).toHaveBeenCalledOnce();
    expect(findLatestUserLog).toHaveBeenCalledOnce();
  });
});
