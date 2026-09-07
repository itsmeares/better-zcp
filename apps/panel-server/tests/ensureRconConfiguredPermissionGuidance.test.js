import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


const isPosix = process.platform !== "win32";

const getActiveServer = vi.fn();
vi.mock("../database/init.ts", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

const { logSpy } = vi.hoisted(() => ({
  logSpy: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../utils/logger.ts", () => ({
  createLogger: () => logSpy,
}));

const { ensureRconConfigured } = await import("../routes/server.js");

afterEach(() => {
  getActiveServer.mockReset();
  logSpy.error.mockReset();
  logSpy.warn.mockReset();
  logSpy.info.mockReset();
  logSpy.debug.mockReset();
});

(isPosix ? describe : describe.skip)(
  "ensureRconConfigured(): translates an EACCES into operator-facing guidance",
  () => {
    it("a serverConfigPath this process genuinely cannot write to logs BOTH the raw errno AND the friendly chown/chmod guidance", async () => {
      const unwritableDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "pz-eacces-guidance-"),
      );
      fs.chmodSync(unwritableDir, 0o500);

      const probePath = path.join(unwritableDir, ".write-probe");
      let reallyBlocked = true;
      try {
        fs.writeFileSync(probePath, "x");
        fs.unlinkSync(probePath);
        reallyBlocked = false;
      } catch {
        reallyBlocked = true;
      }

      getActiveServer.mockResolvedValue({
        serverName: "TestServer",
        serverConfigPath: unwritableDir,
        rconPassword: "hunter2",
        rconPort: 27015,
      });

      const result = await ensureRconConfigured();

      if (!reallyBlocked) {
        expect(result).toBe(true);
        fs.rmSync(unwritableDir, { recursive: true, force: true });
        return;
      }

      expect(result).toBe(false);
      const loggedError = logSpy.error.mock.calls
        .map((call) => call[0])
        .find((msg) => msg.includes("EACCES") || msg.includes("Failed to pre-create"));
      expect(loggedError).toBeTruthy();
      expect(loggedError).toMatch(/EACCES/);
      expect(loggedError).toMatch(/chown|chmod/i);

      fs.chmodSync(unwritableDir, 0o700);
      fs.rmSync(unwritableDir, { recursive: true, force: true });
    });

    it("positive control: a genuinely writable serverConfigPath configures RCON normally with no guidance text logged", async () => {
      const writableDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "pz-eacces-guidance-ok-"),
      );

      getActiveServer.mockResolvedValue({
        serverName: "TestServer",
        serverConfigPath: writableDir,
        rconPassword: "hunter2",
        rconPort: 27015,
      });

      const result = await ensureRconConfigured();

      expect(result).toBe(true);
      const guidanceLogged = logSpy.error.mock.calls
        .map((call) => call[0])
        .some((msg) => /chown|chmod/i.test(msg));
      expect(guidanceLogged).toBe(false);

      fs.rmSync(writableDir, { recursive: true, force: true });
    });
  },
);
