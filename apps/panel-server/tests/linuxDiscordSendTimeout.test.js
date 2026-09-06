import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// hunt-wave5-2026-08-29: the panel's only outbound alerting is Discord, and
// nobody had tested what happens when Discord stops answering. Traced (and
// confirmed against a real, unmocked discord.js REST manager talking to a
// local mock Discord API) that @discordjs/rest retries a 429 response
// FOREVER with no attempt cap -- its runRequest() re-recurses on every 429
// without ever incrementing the same `retries` counter a non-429 failure
// uses (that path IS capped at options.retries = 3, see @discordjs/rest's
// own source around its 429 branch). A real (mocked) Discord API returning
// 429 on every attempt left channel.send() unresolved past 60 real seconds,
// with _sendToChannel()'s catch block -- and the circuit breaker it drives
// -- never reached, because the promise never settles. This is the exact
// "reports nothing, reaches nobody" failure shape a delivery mechanism can
// have: not a thrown error, a permanently pending one.
//
// This test can't reproduce THAT (it would need a real discord.js REST
// manager and a mock HTTP server, which is what proved the bug in the first
// place -- see the hunt report for that harness). What it verifies instead
// is the actual fix: _sendToChannel() now races channel.send() against its
// own SEND_TIMEOUT_MS ceiling, so a send that never settles for ANY reason
// still resolves to `false` and still drives the circuit breaker, instead
// of hanging forever. Uses fake timers so a 30-second bound doesn't cost 30
// real seconds per test run.

vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async () => null,
  setSetting: async () => {},
}));

const { DiscordBot } = await import("../services/discordBot.js");

function makeBotWithFakeClient(sendImpl) {
  const bot = new DiscordBot(null, null, null, null);
  bot.channelId = "channel-1";
  bot.client = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: sendImpl,
      }),
    },
  };
  return bot;
}

describe("DiscordBot._sendToChannel() — a send that never settles", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("still resolves to false instead of hanging forever, and counts as a breaker failure", async () => {
    // Simulates exactly what the real bug looked like: channel.send()
    // returns a promise that never resolves or rejects -- the shape a
    // sustained 429 produces inside discord.js's own retry loop.
    const bot = makeBotWithFakeClient(() => new Promise(() => {}));

    const resultPromise = bot._sendToChannel("channel-1", "hello");
    // Advance past the 30s send-timeout ceiling. Without the fix, this
    // promise would still be pending after any amount of fake-timer
    // advancement, because nothing races it -- the test would time out at
    // vitest's own test-level timeout instead of resolving.
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await resultPromise;

    expect(result).toBe(false);
    expect(bot._breakerFor("channel-1").failures).toBe(1);
  });

  it("classifies the resulting timeout as transient (ETIMEDOUT), not a config problem", async () => {
    const bot = makeBotWithFakeClient(() => new Promise(() => {}));

    // Drive the breaker to its FAILURE_THRESHOLD (3) with the same hung-send
    // shape, to check which cooldown it picks -- 5 min (transient) vs 30 min
    // (misconfigured). A permanently-pending send is a delivery problem, not
    // a channel/permissions problem, and must not get the longer treatment.
    for (let i = 0; i < 3; i++) {
      const p = bot._sendToChannel("channel-1", `attempt ${i}`);
      await vi.advanceTimersByTimeAsync(31_000);
      await p;
    }

    const breaker = bot._breakerFor("channel-1");
    expect(breaker.failures).toBe(3);
    // 5 minutes, not the 30-minute "misconfigured" cooldown.
    const remaining = breaker.openUntil - Date.now();
    expect(remaining).toBeGreaterThan(4 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it("a send that resolves well within the timeout is unaffected", async () => {
    const bot = makeBotWithFakeClient(async () => "ok");

    const result = await bot._sendToChannel("channel-1", "hello");

    expect(result).toBe(true);
    expect(bot._breakerFor("channel-1").failures).toBe(0);
  });
});

describe("DiscordBot._sendToChannel() — a real Discord-side outage (5xx)", () => {
  it("classifies a 5xx as transient (unreachable), not misconfigured", async () => {
    const apiError = new Error("Internal Server Error");
    apiError.status = 503; // shape of @discordjs/rest's DiscordAPIError/HTTPError
    const bot = makeBotWithFakeClient(async () => {
      throw apiError;
    });

    for (let i = 0; i < 3; i++) {
      await bot._sendToChannel("channel-1", `attempt ${i}`);
    }

    const breaker = bot._breakerFor("channel-1");
    expect(breaker.failures).toBe(3);
    const remaining = breaker.openUntil - Date.now();
    // 5 minutes (transient), not 30 (misconfigured) -- before this fix, a
    // 5xx fell through to the "misconfigured (likely channel/perms)" branch
    // because the transient check only ever looked at error.message for
    // network-level substrings, never at the error's actual HTTP status.
    expect(remaining).toBeGreaterThan(4 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it("a non-5xx, non-network failure (e.g. deleted channel) still gets the longer cooldown", async () => {
    const apiError = new Error("Unknown Channel");
    apiError.status = 404;
    const bot = makeBotWithFakeClient(async () => {
      throw apiError;
    });

    for (let i = 0; i < 3; i++) {
      await bot._sendToChannel("channel-1", `attempt ${i}`);
    }

    const breaker = bot._breakerFor("channel-1");
    expect(breaker.failures).toBe(3);
    const remaining = breaker.openUntil - Date.now();
    expect(remaining).toBeGreaterThan(25 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(30 * 60 * 1000);
  });
});
