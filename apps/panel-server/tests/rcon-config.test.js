import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Both defects here are the same shape as the startup fallback probe fixed in
// rcon-autoprobe.test.js, one layer deeper: RconService itself will happily
// fall back to the hardcoded default host/port (127.0.0.1:27015, empty
// password) whenever it can't fully resolve a configured server. That
// fallback is what the 60s auto-reconnect interval hits, forever, on a
// completely unconfigured install.

const getActiveServer = vi.fn();
const getServer = vi.fn();
const getSetting = vi.fn();
const logCommand = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getServer,
  getSetting,
  logCommand,
}));

const { RconService } = await import("../services/rcon.js");

function freshService() {
  const service = new RconService();
  // Constructor reads process.env.RCON_HOST/PORT/RCON_PASSWORD_FILE — pin to
  // known values so assertions aren't sensitive to the shell running the
  // suite happening to have one of those set.
  service.config = { host: "127.0.0.1", port: 27015, password: "" };
  service.passwordFromSecretFile = false;
  return service;
}

beforeEach(() => {
  getActiveServer.mockReset().mockResolvedValue(null);
  getServer.mockReset().mockResolvedValue(null);
  getSetting.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RconService.hasConfiguredTarget", () => {
  it("is false with no server row and no legacy global settings", async () => {
    const service = freshService();
    expect(await service.hasConfiguredTarget()).toBe(false);
  });

  it("is true when a server has been added, even with no RCON password", async () => {
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "",
    });
    const service = freshService();
    expect(await service.hasConfiguredTarget()).toBe(true);
  });

  it("is true from legacy global settings alone, with no server row (back-compat)", async () => {
    getSetting.mockImplementation(async (key) =>
      key === "rconHost" ? "legacy.example.com" : null,
    );
    const service = freshService();
    expect(await service.hasConfiguredTarget()).toBe(true);
  });
});

describe("RconService.loadConfig", () => {
  it("uses the active server's host, port and password when all are set", async () => {
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "correct-horse",
    });
    const service = freshService();
    await service.loadConfig();
    expect(service.config).toMatchObject({
      host: "10.20.30.40",
      port: 27099,
      password: "correct-horse",
    });
  });

  it("keeps the configured server's real host/port even with no RCON password set (the crack)", async () => {
    // A freshly added PZ server with no password yet is a completely normal
    // state. It must never look identical to "nothing configured at all".
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "",
    });
    const service = freshService();
    service.config.password = "stale-password-from-a-previous-server";
    await service.loadConfig();
    expect(service.config.host).toBe("10.20.30.40");
    expect(service.config.port).toBe(27099);
    // Doesn't silently keep authenticating as whatever this instance last
    // pointed at — an empty password is real state, not a value to inherit.
    expect(service.config.password).toBe("");
  });

  it("same crack, for a serverId-pinned lookup (Scheduler's throwaway instances)", async () => {
    getServer.mockResolvedValue({
      id: "srv-2",
      rconHost: "10.20.30.41",
      rconPort: 27100,
      rconPassword: "",
    });
    const service = freshService();
    await service.loadConfig("srv-2");
    expect(service.config.host).toBe("10.20.30.41");
    expect(service.config.port).toBe(27100);
  });

  it("still falls back to legacy global settings when there is no server row at all", async () => {
    getSetting.mockImplementation(async (key) => {
      if (key === "rconHost") return "legacy.example.com";
      if (key === "rconPort") return "27016";
      if (key === "rconPassword") return "legacy-pw";
      return null;
    });
    const service = freshService();
    await service.loadConfig();
    expect(service.config).toMatchObject({
      host: "legacy.example.com",
      port: 27016,
      password: "legacy-pw",
    });
  });

  it("does not truncate a malformed profile port into a different target", async () => {
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: "27016junk",
      rconPassword: "correct-horse",
    });
    const service = freshService();
    service.checkPortOpen = vi.fn(async () => true);

    expect(await service.connect()).toBe(false);
    expect(service.config.port).toBeNull();
    expect(service.checkPortOpen).not.toHaveBeenCalled();
  });

  it("does not truncate a malformed legacy port into a different target", async () => {
    getSetting.mockImplementation(async (key) => {
      if (key === "rconHost") return "legacy.example.com";
      if (key === "rconPort") return "27016junk";
      return null;
    });
    const service = freshService();
    service.checkPortOpen = vi.fn(async () => true);

    expect(await service.connect()).toBe(false);
    expect(service.config.port).toBeNull();
    expect(service.checkPortOpen).not.toHaveBeenCalled();
  });

  it("a bad serverId lookup does NOT fall back to legacy/active settings (fails loudly instead)", async () => {
    getServer.mockResolvedValue(null);
    getSetting.mockImplementation(async (key) =>
      key === "rconHost" ? "should-not-be-used.example.com" : null,
    );
    const service = freshService();
    await service.loadConfig("does-not-exist");
    expect(service.config.host).toBe("127.0.0.1");
  });
});

describe("RconService auto-reconnect gate (connect/_doConnect)", () => {
  it("makes zero connection attempts when nothing has ever been configured", async () => {
    const service = freshService();
    const checkPortOpen = vi.fn(async () => true);
    service.checkPortOpen = checkPortOpen;

    const result = await service.connect();

    expect(result).toBe(false);
    expect(checkPortOpen).not.toHaveBeenCalled();
    // Config was never touched — still the untouched fixture default, not
    // silently marked "loaded".
    expect(service.configLoaded).toBe(false);
  });

  it("still probes a configured server whose process couldn't be detected (the case that must keep working)", async () => {
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "correct-horse",
    });
    const service = freshService();
    const checkPortOpen = vi.fn(async () => false); // port genuinely closed; we only need to prove it was asked, not fake a full RCON handshake
    service.checkPortOpen = checkPortOpen;

    const result = await service.connect();

    expect(result).toBe(false);
    expect(checkPortOpen).toHaveBeenCalledTimes(1);
    expect(checkPortOpen).toHaveBeenCalledWith("10.20.30.40", 27099);
  });

  it("adapts within one reconnect attempt after a server is added mid-run, without a restart", async () => {
    const service = freshService();
    const checkPortOpen = vi.fn(async () => false);
    service.checkPortOpen = checkPortOpen;

    // Tick 1: still unconfigured.
    expect(await service.connect()).toBe(false);
    expect(checkPortOpen).not.toHaveBeenCalled();

    // Operator adds a server while the panel keeps running.
    getActiveServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "correct-horse",
    });

    // Tick 2 (the next 60s auto-reconnect attempt): no restart, no explicit
    // reloadConfig() call from this test — hasConfiguredTarget() is checked
    // fresh every attempt, so it's picked up immediately.
    expect(await service.connect()).toBe(false); // port still reported closed
    expect(checkPortOpen).toHaveBeenCalledWith("10.20.30.40", 27099);
  });
});
