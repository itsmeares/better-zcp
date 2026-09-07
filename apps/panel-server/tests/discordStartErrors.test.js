import { beforeEach, describe, expect, it, vi } from "vitest";


vi.mock("../services/discordBot.ts", () => ({
  normalizeChatRelayScope: vi.fn((value) => value),
}));

import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";
vi.mock("../database/init.js", () => ({
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/discord.ts");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const res = createResponse();
  const handlers = getHandlers(routePath, method);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

function mockDiscordBot(lastStartError) {
  return {
    isRunning: false,
    lastStartError,
    start: vi.fn(async () => false),
  };
}

describe("POST /discord/start -- distinguishes why the bot didn't start", () => {
  const baseReq = { user: { role: "admin" } };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("DisallowedIntents -- names the privileged intents, says it isn't a credentials problem", async () => {
    const discordBot = mockDiscordBot({ kind: "DisallowedIntents", message: "Privileged intent provided is not enabled or whitelisted." });
    const res = await runRoute("/start", "post", { ...baseReq, app: { get: () => discordBot } });
    expect(res.status).toHaveBeenCalledWith(400);
    const payload = res.json.mock.calls[0][0];
    expect(payload.error).toMatch(/privileged/i);
    expect(payload.error).toMatch(/Server Members/);
    expect(payload.error).toMatch(/Message Content/);
    expect(payload.error).toMatch(/not a token or ID problem/i);
  });

  it("TokenInvalid -- says the token is wrong", async () => {
    const discordBot = mockDiscordBot({ kind: "TokenInvalid", message: "An invalid token was provided." });
    const res = await runRoute("/start", "post", { ...baseReq, app: { get: () => discordBot } });
    const payload = res.json.mock.calls[0][0];
    expect(payload.error).toMatch(/invalid token/i);
  });

  it("ReadyTimeout -- blames the network, not the configuration", async () => {
    const discordBot = mockDiscordBot({ kind: "ReadyTimeout", message: "Bot ready timeout after 30s" });
    const res = await runRoute("/start", "post", { ...baseReq, app: { get: () => discordBot } });
    const payload = res.json.mock.calls[0][0];
    expect(payload.error).toMatch(/network/i);
    expect(payload.error).not.toMatch(/check configuration/i);
  });

  it("NoToken -- says no token is configured", async () => {
    const discordBot = mockDiscordBot({ kind: "NoToken", message: "No bot token is configured." });
    const res = await runRoute("/start", "post", { ...baseReq, app: { get: () => discordBot } });
    const payload = res.json.mock.calls[0][0];
    expect(payload.error).toMatch(/no bot token/i);
  });

  it("an unrecognized discord.js error still surfaces its real message instead of the generic banner", async () => {
    const discordBot = mockDiscordBot({ kind: "SomeOtherDjsCode", message: "Something specific broke" });
    const res = await runRoute("/start", "post", { ...baseReq, app: { get: () => discordBot } });
    const payload = res.json.mock.calls[0][0];
    expect(payload.error).toContain("Something specific broke");
  });

  it("falls back to the generic message only when there is truly no captured reason", async () => {
    const discordBot = mockDiscordBot(null);
    const res = await runRoute("/start", "post", { ...baseReq, app: { get: () => discordBot } });
    const payload = res.json.mock.calls[0][0];
    expect(payload.error).toBe("Failed to start bot - check configuration");
  });
});
