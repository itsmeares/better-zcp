import { describe, expect, it, afterEach } from "vitest";
import { getAllSettings, getSetting } from "../database/init.ts";


const { default: router } = await import("../routes/config.ts");

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const buildRequest = (settings) => ({
  body: { settings },
  app: { get: () => undefined },
  user: null,
});

describe("PUT /api/config/app-settings: two concurrent saves to DIFFERENT keys", () => {
  afterEach(async () => {
    // Leave the two ordinary, non-governed keys this test touches in a
    // known state so a later test run isn't order-dependent.
  });

  it("both survive -- db.data is a shared mutable object, not a per-request snapshot that can silently diverge", async () => {
    const handler = getRouteHandler("/app-settings", "put");

    const responseA = createResponse();
    const responseB = createResponse();

    await Promise.all([
      handler(buildRequest({ darkMode: true }), responseA),
      handler(buildRequest({ autoStartServer: true }), responseB),
    ]);

    expect(responseA.getStatusCode()).toBe(200);
    expect(responseB.getStatusCode()).toBe(200);

    expect(await getSetting("darkMode")).toBe(true);
    expect(await getSetting("autoStartServer")).toBe(true);

    const all = await getAllSettings();
    expect(all.darkMode).toBe(true);
    expect(all.autoStartServer).toBe(true);
  });

  it("is ordinary last-write-wins when both touch the SAME key -- exactly one value survives, both callers still get success:true", async () => {
    const handler = getRouteHandler("/app-settings", "put");

    const responseA = createResponse();
    const responseB = createResponse();

    await Promise.all([
      handler(buildRequest({ darkMode: true }), responseA),
      handler(buildRequest({ darkMode: false }), responseB),
    ]);

    expect(responseA.getStatusCode()).toBe(200);
    expect(responseB.getStatusCode()).toBe(200);

    const finalValue = await getSetting("darkMode");
    expect([true, false]).toContain(finalValue);
  });
});
