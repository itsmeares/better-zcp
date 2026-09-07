import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


vi.mock("../services/discordBot.ts", () => ({
  normalizeChatRelayScope: vi.fn((value) => value),
}));

import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";
vi.mock("../database/init.ts", () => ({
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/discord.ts");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const res = createResponse();
  const handlers = getHandler(routePath, method);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

const VALID_TOKEN = "a".repeat(59) + "." + "b".repeat(6) + "." + "c".repeat(27);

function mockFetchOnce(status) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({}),
    })),
  );
}

describe("POST /discord/test -- distinguishes why Discord's API said no", () => {
  const req = { user: { role: "admin" }, body: { token: VALID_TOKEN } };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("401 -- reports Invalid token, the only case that phrase is accurate", async () => {
    mockFetchOnce(401);
    const res = await runRoute("/test", "post", req);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Invalid token",
      code: "DISCORD_TEST_TOKEN_INVALID",
    });
  });

  it("429 -- reports rate limiting, not a bad token", async () => {
    mockFetchOnce(429);
    const res = await runRoute("/test", "post", req);
    expect(res.status).toHaveBeenCalledWith(429);
    const payload = res.json.mock.calls[0][0];
    expect(payload.error).toMatch(/rate.limit/i);
    expect(payload.error).not.toMatch(/invalid token/i);
  });

  it("503 -- reports Discord's API is unavailable, not a bad token", async () => {
    mockFetchOnce(503);
    const res = await runRoute("/test", "post", req);
    expect(res.status).toHaveBeenCalledWith(502);
    const payload = res.json.mock.calls[0][0];
    expect(payload.error).toMatch(/unavailable/i);
    expect(payload.error).not.toMatch(/invalid token/i);
  });

  it("403 -- reports the real HTTP status rather than defaulting to Invalid token", async () => {
    mockFetchOnce(403);
    const res = await runRoute("/test", "post", req);
    expect(res.status).toHaveBeenCalledWith(400);
    const payload = res.json.mock.calls[0][0];
    expect(payload.error).toMatch(/403/);
    expect(payload.error).not.toMatch(/invalid token/i);
  });
});
