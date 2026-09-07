import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";


vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async () => null,
  setSetting: async () => {},
}));

const { DiscordBot } = await import("../services/discordBot.ts");

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
    const bot = makeBotWithFakeClient(() => new Promise(() => {}));

    const resultPromise = bot._sendToChannel("channel-1", "hello");
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await resultPromise;

    expect(result).toBe(false);
    expect(bot._breakerFor("channel-1").failures).toBe(1);
  });

  it("classifies the resulting timeout as transient (ETIMEDOUT), not a config problem", async () => {
    const bot = makeBotWithFakeClient(() => new Promise(() => {}));

    for (let i = 0; i < 3; i++) {
      const p = bot._sendToChannel("channel-1", `attempt ${i}`);
      await vi.advanceTimersByTimeAsync(31_000);
      await p;
    }

    const breaker = bot._breakerFor("channel-1");
    expect(breaker.failures).toBe(3);
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
    apiError.status = 503;
    const bot = makeBotWithFakeClient(async () => {
      throw apiError;
    });

    for (let i = 0; i < 3; i++) {
      await bot._sendToChannel("channel-1", `attempt ${i}`);
    }

    const breaker = bot._breakerFor("channel-1");
    expect(breaker.failures).toBe(3);
    const remaining = breaker.openUntil - Date.now();
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
