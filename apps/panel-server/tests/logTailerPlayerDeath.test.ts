import { describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("keeps the old offset after a read error so the next poll can emit the death", async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-logtailer-"));
    const userLogPath = path.join(logsDir, "players_user.txt");
    fs.writeFileSync(userLogPath, "new log bytes");

    try {
      const tailer = new LogTailer();
      tailer.logsDir = logsDir;
      tailer.userLogPath = userLogPath;
      vi.spyOn(tailer as any, "findLatestUserLog").mockImplementation(() => {});
      vi.spyOn(tailer as any, "readChunk")
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("user Alice died at (1,2,0)\n");
      const deaths: unknown[] = [];
      tailer.on("playerDeath", (death) => deaths.push(death));

      await tailer.checkUserLog();
      expect(tailer.userLogSize).toBe(0);
      expect(deaths).toHaveLength(0);

      await tailer.checkUserLog();
      expect(tailer.userLogSize).toBe(fs.statSync(userLogPath).size);
      expect(deaths).toEqual([
        expect.objectContaining({ player: "Alice", location: "1,2,0" }),
      ]);
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });
});
