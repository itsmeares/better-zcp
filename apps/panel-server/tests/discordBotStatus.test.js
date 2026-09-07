import { describe, expect, it, vi } from "vitest";


vi.mock("../database/init.ts", () => ({
  getActiveServer: async () => null,
  getSetting: async () => null,
  setSetting: async () => {},
}));

const { DiscordBot } = await import("../services/discordBot.ts");

describe("DiscordBot.getStatus() — lastStartError", () => {
  it("is null when nothing has failed to start", () => {
    const bot = new DiscordBot(null, null, null, null);
    expect(bot.getStatus().lastStartError).toBeNull();
  });

  it("surfaces the same specific reason describeStartFailure() would give the toast", () => {
    const bot = new DiscordBot(null, null, null, null);
    bot.lastStartError = { kind: "DisallowedIntents", message: "Privileged intent provided is not enabled or whitelisted." };

    const status = bot.getStatus();

    expect(status.lastStartError).toEqual({
      kind: "DisallowedIntents",
      message: expect.stringMatching(/privileged/i),
    });
    expect(status.lastStartError.message).toMatch(/Server Members/);
    expect(status.lastStartError.message).not.toMatch(/check configuration/i);
  });

  // NOT tested here: that a successful start() actually clears
  // lastStartError (the clientReady handler inside start() does this).
  // Exercising that honestly needs a real Discord gateway connection to
  // succeed, which is out of reach for a unit test -- verified by reading
  // start()'s clientReady handler instead (apps/panel-server/services/discordBot.ts).
});
