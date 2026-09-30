import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";


const getCurrentServer = vi.fn();
const getServer = vi.fn();
const getSetting = vi.fn();
const logCommand = vi.fn();

vi.mock("../database/init.ts", () => ({
  getCurrentServer,
  getServer,
  getSetting,
  logCommand,
}));

const { RconService } = await import("../services/rcon.ts");

function freshService() {
  const service = new RconService("srv-1");
  service.config = { host: "127.0.0.1", port: 27015, password: "" };
  service.passwordFromSecretFile = false;
  return service;
}

beforeEach(() => {
  getCurrentServer.mockReset().mockResolvedValue(null);
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
    getServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "",
    });
    const service = freshService();
    expect(await service.hasConfiguredTarget()).toBe(true);
  });


});

describe("RconService.loadConfig", () => {
  it("uses the active server's host, port and password when all are set", async () => {
    getServer.mockResolvedValue({
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
    getServer.mockResolvedValue({
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
    const other = new RconService("srv-2");
    await other.loadConfig();
    expect(other.config.host).toBe("10.20.30.41");
    expect(other.config.port).toBe(27100);
  });



  it("does not truncate a malformed profile port into a different target", async () => {
    getServer.mockResolvedValue({
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




});

describe("RconService auto-reconnect gate (connect/_doConnect)", () => {
  it("makes zero connection attempts when nothing has ever been configured", async () => {
    const service = freshService();
    const checkPortOpen = vi.fn(async () => true);
    service.checkPortOpen = checkPortOpen;

    expect(await service.connect()).toBe(false);
    expect(checkPortOpen).not.toHaveBeenCalled();
  });

  it("still probes a configured server whose process couldn't be detected (the case that must keep working)", async () => {
    getServer.mockResolvedValue({
      id: "srv-1",
      rconHost: "10.20.30.40",
      rconPort: 27099,
      rconPassword: "correct-horse",
    });
    const service = freshService();
    const checkPortOpen = vi.fn(async () => false);
    service.checkPortOpen = checkPortOpen;

    const result = await service.connect();

    expect(result).toBe(false);
    expect(checkPortOpen).toHaveBeenCalledTimes(1);
    expect(checkPortOpen).toHaveBeenCalledWith("10.20.30.40", 27099);
  });


});
