import { describe, expect, it, vi } from "vitest";

// hunt-wave6-2026-08-29 follow-up 2 (operator-visible signal): getStatus()
// used to have no field at all for gateway health -- a real, self-healing
// heartbeat black hole (suspect 4) and a permanent, unrecoverable shard
// disconnect both left `running` reporting true throughout, so an operator
// watching the page saw a healthy bot while alerting was actually down.
//
// This file tests getStatus()'s DEBOUNCE MATH directly and fast, by
// manipulating the internal _gatewayDegradedSince field the same way
// existing tests poke _channelBreakers -- no real network needed for this
// half. The event WIRING (does a real shardReconnecting/shardResume/
// shardDisconnect from an actual discord.js Client actually drive that
// field) is proven separately, against a real gateway mock, in
// linuxDiscordGatewayResilience.test.js -- that file also confirms a real,
// fast (~2-3s) RESUME never crosses this threshold, so this file's job is
// only to prove the threshold arithmetic itself is correct.

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
    bot._gatewayDegradedSince = Date.now() - 5_000; // 5s in -- suspect 4 measured real RESUME at ~2-3s
    const status = bot.getStatus();
    expect(status.gatewayIssue).toBe(false);
    expect(status.gatewayDegradedSince).toBeNull();
  });

  it("degraded past the threshold: gatewayIssue true, gatewayDegradedSince is the real episode-start timestamp", () => {
    const bot = makeBot();
    const since = Date.now() - 31_000; // just past GATEWAY_DEGRADED_THRESHOLD_MS (30s)
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
    bot._gatewayDegradedSince = Date.now() - 120_000; // was degraded for 2 real minutes
    bot._gatewayDegradedSince = null; // ...then a shardResume/shardReady handler fired
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
