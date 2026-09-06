import { describe, expect, it, vi } from "vitest";


const FAKE_PASSWORD = "fake-rcon-secret-hunter2-for-test-only";

vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async () => null,
  setSetting: async () => {},
  logCommand: () => {},
}));

const { RconService } = await import("../services/rcon.js");
const { DiscordBot } = await import("../services/discordBot.js");

describe("layer 1 -- RconService.getUserFriendlyError() neutralizes an interpolated timeout message on contact", () => {
  it("a raw sourceRcon.js-shaped timeout message containing the password never survives the classifier", () => {
    const service = new RconService();
    const raw = `RCON command timed out: adduser bob ${FAKE_PASSWORD}`;
    const friendly = service.getUserFriendlyError(raw);

    expect(friendly).not.toContain(FAKE_PASSWORD);
    expect(friendly).toBe(
      "Connection timed out. Server may be unresponsive or firewall is blocking.",
    );
  });
});

describe("layer 2 -- RconService.execute() routes a timed-out command away from the caller entirely, real reconnect logic included", () => {
  function makeService({ reconnectSucceeds }) {
    const service = new RconService();
    service.connected = true;
    service.serverStarting = false;
    const command = `adduser bob ${FAKE_PASSWORD}`;
    service.client = {
      execute: () => Promise.reject(new Error(`RCON command timed out: ${command}`)),
    };
    service.reconnect = reconnectSucceeds
      ? async () => {
          service.connected = true;
          service.client = { execute: async () => "Player added successfully" };
          return true;
        }
      : async () => {
          service.connected = false;
          throw new Error("RCON reconnection failed: ECONNREFUSED");
        };
    return { service, command };
  }

  it("reconnect succeeds after the timeout -- the retried result carries no trace of the original password-bearing message", async () => {
    const { service, command } = makeService({ reconnectSucceeds: true });
    const result = await service.execute(command, {
      retryOnConnectionError: true,
    });

    expect(JSON.stringify(result)).not.toContain(FAKE_PASSWORD);
    expect(result).toEqual({ success: true, response: "Player added successfully" });
  });

  it("reconnect fails after the timeout -- the returned error is the RECONNECT failure, not the original timeout message", async () => {
    const { service, command } = makeService({ reconnectSucceeds: false });
    const result = await service.execute(command, {
      retryOnConnectionError: true,
    });

    expect(JSON.stringify(result)).not.toContain(FAKE_PASSWORD);
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Cannot connect to server. Is the game server running with RCON enabled?",
    );
  });
});

describe("layer 3 -- DiscordBot.handleRcon() end to end: the actual Discord-bound reply text is clean", () => {
  function makeFakeInteraction(command) {
    return {
      options: { getString: () => command },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("a command that times out internally (password included) never appears in what gets posted to Discord", async () => {
    const command = `adduser bob ${FAKE_PASSWORD}`;
    const rconService = {
      connected: true,
      sanitize: (input) => String(input), // no quotes/backslashes in this command, passthrough is faithful
      execute: async () => {
        const service = new RconService();
        service.connected = true;
        service.client = {
          execute: () => Promise.reject(new Error(`RCON command timed out: ${command}`)),
        };
        service.reconnect = async () => {
          throw new Error("RCON reconnection failed: ECONNREFUSED");
        };
        return service.execute(command, { retryOnConnectionError: true });
      },
    };
    const bot = new DiscordBot(rconService, null, null, null);
    const interaction = makeFakeInteraction(command);

    await bot.handleRcon(interaction);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const posted = interaction.editReply.mock.calls[0][0];
    const postedText = typeof posted === "string" ? posted : JSON.stringify(posted);
    expect(postedText).not.toContain(FAKE_PASSWORD);
    expect(postedText).toContain("Error");
  });
});
