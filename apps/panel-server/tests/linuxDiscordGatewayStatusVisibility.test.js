import { describe, expect, it, vi } from "vitest";


vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async () => null,
  setSetting: async () => {},
}));

const { DiscordBot } = await import("../services/discordBot.js");

function makeBot() {
  return new DiscordBot(null, null, null, null);
}

describe("DiscordBot.getStatus() -- gatewayIssue debounce", () => {
  it("healthy (never degraded): gatewayIssue false, gatewayDegradedSince null", () => {
    const bot = makeBot();
    const status = bot.getStatus();
    expect(status.gatewayIssue).toBe(false);
    expect(status.gatewayDegradedSince).toBeNull();
  });

  it("degraded but well under the threshold (a routine blip in progress): still reports healthy", () => {
    const bot = makeBot();
    bot._gatewayDegradedSince = Date.now() - 5_000;
    const status = bot.getStatus();
    expect(status.gatewayIssue).toBe(false);
    expect(status.gatewayDegradedSince).toBeNull();
  });

  it("degraded past the threshold: gatewayIssue true, gatewayDegradedSince is the real episode-start timestamp", () => {
    const bot = makeBot();
    const since = Date.now() - 31_000;
    bot._gatewayDegradedSince = since;
    const status = bot.getStatus();
    expect(status.gatewayIssue).toBe(true);
    expect(status.gatewayDegradedSince).toBe(new Date(since).toISOString());
  });

  it("exactly at the threshold boundary counts as degraded (>=, not >)", () => {
    const bot = makeBot();
    bot._gatewayDegradedSince = Date.now() - 30_000;
    expect(bot.getStatus().gatewayIssue).toBe(true);
  });

  it("recovering (a resume/ready handler cleared the field) immediately reports healthy again, even moments after a long degraded stretch", () => {
    const bot = makeBot();
    bot._gatewayDegradedSince = Date.now() - 120_000;
    bot._gatewayDegradedSince = null;
    const status = bot.getStatus();
    expect(status.gatewayIssue).toBe(false);
    expect(status.gatewayDegradedSince).toBeNull();
  });
});

describe("DiscordBot.stop() -- gateway-degraded state does not leak across a stop/restart cycle", () => {
  it("stop() clears _gatewayDegradedSince, same as it already clears breaker state", async () => {
    const bot = makeBot();
    bot._gatewayDegradedSince = Date.now() - 60_000;
    bot.client = { destroy: vi.fn().mockResolvedValue(undefined) };
    bot.isRunning = true;

    await bot.stop();

    expect(bot._gatewayDegradedSince).toBeNull();
    expect(bot.getStatus().gatewayIssue).toBe(false);
  });
});
