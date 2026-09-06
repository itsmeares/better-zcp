import { describe, expect, it, vi } from "vitest";

// conv-userbugs follow-up: getStatus() never returned an error field in
// normal operation, so a start() failure's real reason only ever reached
// the user as a one-time toast at the instant they clicked Start -- gone on
// refresh or a later visit, which is exactly what a user "stuck long enough
// to ask twice" would do. getStatus() now includes lastStartError, mapped
// through the same describeStartFailure() used for the toast, so the two
// never say different things about the same failure.

vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async () => null,
  setSetting: async () => {},
}));

const { DiscordBot } = await import("../services/discordBot.js");

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
  // start()'s clientReady handler instead (apps/panel-server/services/discordBot.js).
});
