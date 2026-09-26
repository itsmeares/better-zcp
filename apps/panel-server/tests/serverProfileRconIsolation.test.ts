import { describe, expect, it, vi } from "vite-plus/test";

const profiles = {
  a: { id: "a", name: "A", serverName: "A", rconHost: "127.0.0.1", rconPort: 27015, rconPassword: "password-a" },
  b: { id: "b", name: "B", serverName: "B", rconHost: "127.0.0.2", rconPort: 27016, rconPassword: "" },
};
let active = profiles.a;

vi.mock("../database/init.ts", () => ({
  getActiveServer: vi.fn(async () => active),
  getServer: vi.fn(async (id) => profiles[id] || null),
  setActiveServer: vi.fn(async (id) => {
    active = profiles[id];
    return active;
  }),
  getServers: vi.fn(async () => Object.values(profiles)),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(),
  logServerEvent: vi.fn(),
  logCommand: vi.fn(),
  createServer: vi.fn(),
  updateServer: vi.fn(),
  deleteServer: vi.fn(),
}));

const { RconService } = await import("../services/rcon.ts");
const { activateServerProfile } = await import("../services/serverProfiles.ts");

describe("RCON identity across profile activation", () => {
  it("disconnects the old profile even when the new profile has no RCON password", async () => {
    active = profiles.a;
    const rconService = new RconService();
    rconService.passwordFromSecretFile = false;
    await rconService.loadConfig();
    const oldClient = { disconnect: vi.fn(), execute: vi.fn() };
    rconService.client = oldClient as any;
    rconService.connected = true;
    const connect = vi.spyOn(rconService, "connect");

    await activateServerProfile("b", {
      serverManager: { reloadConfig: vi.fn() },
      rconService,
    });

    expect(oldClient.disconnect).toHaveBeenCalledOnce();
    expect(rconService.client).toBeNull();
    expect(rconService.config).toMatchObject({ host: "127.0.0.2", port: 27016, password: "" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("never retries an old command on the newly selected profile", async () => {
    active = profiles.a;
    const rconService = new RconService();
    rconService.passwordFromSecretFile = false;
    await rconService.loadConfig();
    let rejectOld!: (error: Error) => void;
    const oldClient = {
      disconnect: vi.fn(),
      execute: vi.fn(() => new Promise((_, reject) => { rejectOld = reject; })),
    };
    rconService.client = oldClient as any;
    rconService.connected = true;
    const reconnect = vi.spyOn(rconService, "reconnect");
    const command = rconService.execute("save", { skipLog: true, retryOnConnectionError: true });
    expect(oldClient.execute).toHaveBeenCalledWith("save");

    await activateServerProfile("b", {
      serverManager: { reloadConfig: vi.fn() },
      rconService,
    });
    rejectOld(new Error("socket hang up ECONNRESET"));
    const result = await command;

    expect(result).toMatchObject({ success: false, commandSent: true });
    expect(result.error).toMatch(/profile changed/i);
    expect(reconnect).not.toHaveBeenCalled();
  });
});
