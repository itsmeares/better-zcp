import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";


vi.mock("../services/discordBot.ts", () => ({
  normalizeChatRelayScope: vi.fn((value) => value),
}));

vi.mock("../database/init.js", () => ({
  getRoleByName: mockGetRoleByName,
  setSetting: vi.fn(async () => {}),
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

const NEW_TOKEN = "new-token-value";
const NEW_GUILD_ID = "123456789012345678";

function mockDiscordBot({ startSucceeds, lastStartError = null }) {
  return {
    token: "old-token-value", // different from NEW_TOKEN -> credentialsChanged
    guildId: "111111111111111111",
    isRunning: true,
    lastStartError,
    loadConfig: vi.fn(async () => {}),
    updateConfig: vi.fn(async () => {}),
    updateChatRelay: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => startSucceeds),
  };
}

function putConfig(discordBot) {
  return runRoute("/config", "put", {
    user: { role: "admin" },
    app: { get: () => discordBot },
    body: { token: NEW_TOKEN, guildId: NEW_GUILD_ID },
  });
}

describe("discord.js PUT /config: the response must reflect whether the reconnect actually succeeded", () => {
  it("reports botStarted:false with a real reason when the post-save reconnect fails, while still saying the config itself saved", async () => {
    const discordBot = mockDiscordBot({
      startSucceeds: false,
      lastStartError: { kind: "TokenInvalid", message: "An invalid token was provided." },
    });

    const res = await putConfig(discordBot);

    expect(discordBot.start).toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.botStarted).toBe(false);
    expect(payload.botStartError).toMatch(/invalid token/i);
  });

  it("reports success cleanly with no botStarted field when the reconnect succeeds", async () => {
    const discordBot = mockDiscordBot({ startSucceeds: true });

    const res = await putConfig(discordBot);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.botStarted).toBeUndefined();
  });
});
