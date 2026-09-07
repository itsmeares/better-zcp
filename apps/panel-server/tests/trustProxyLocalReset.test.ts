import { describe, expect, it, vi } from "vitest";


const { default: router } = await import("../routes/auth.ts");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function reqBehindTrustProxy(remoteAddress) {
  return {
    socket: { remoteAddress },
    connection: {},
    app: { get: (key) => (key === "trust proxy" ? 1 : undefined) },
    headers: {},
    cookies: {},
  };
}

function reqDirect(remoteAddress) {
  return {
    socket: { remoteAddress },
    connection: {},
    headers: {},
    cookies: {},
  };
}

describe("POST /auth/reset-token/local: fails closed behind a reverse proxy", () => {
  it("refuses a loopback-socket request once trust proxy is configured, and the message teaches why + what to do instead", async () => {
    const res = createResponse();
    await getHandler("/reset-token/local", "post")(
      reqBehindTrustProxy("127.0.0.1"),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe("LOCAL_RESET_BEHIND_PROXY");
    expect(body.error).toMatch(/reverse proxy/i);
    expect(body.error).toMatch(/reset-token\.txt|recovery code/i);
  });
});

describe("GET /auth/reset-status: localResetSupported follows the same fail-closed rule", () => {
  it("reports localResetSupported: false for a loopback peer once trust proxy is configured", async () => {
    const res = createResponse();
    await getHandler("/reset-status", "get")(
      reqBehindTrustProxy("127.0.0.1"),
      res,
    );

    expect(res.json.mock.calls[0][0].localResetSupported).toBe(false);
  });

  it("trust proxy off: a loopback peer still reports localResetSupported: true (unchanged)", async () => {
    const res = createResponse();
    await getHandler("/reset-status", "get")(reqDirect("127.0.0.1"), res);

    expect(res.json.mock.calls[0][0].localResetSupported).toBe(true);
  });
});
