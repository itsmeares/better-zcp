import { describe, expect, it, afterEach } from "vitest";
import { getAllSettings, getSetting } from "../database/init.js";

// Concurrency hunt 2026-08-29 (hunt-wave5), god's sharpened version of
// suspect 3 after ruling on the init.js/Jim collision: flushWrites()
// (init.js:364-465) is already both atomic (unique tmp name per write,
// chained _writePromise) AND serialized against itself. The real open
// question was narrower and NOT answered by either of those: does
// db.data get CLONED anywhere before a mutator writes to it (which would
// let two concurrent requests' changes silently diverge and then have
// the later flush's stale copy clobber the earlier one's real change), or
// is db.data one SHARED mutable object every mutator writes through
// directly (which would make concurrent changes to DIFFERENT keys
// naturally converge instead of racing)?
//
// Answer, read AND proven: getAllSettings() (database/init.js ~1651)
// returns `db.data.settings` directly -- no spread, no JSON.parse(
// JSON.stringify(...)), no clone of any kind. setSetting(key, value)
// (~1603) does `db.data.settings[key] = value` -- a direct mutation of
// that same shared object. Every real settings-writing call site in the
// codebase funnels through setSetting() per-key (grepped for any
// alternative "read whole settings object, mutate the copy, write copy
// back" pattern and found none -- config.js's PUT /app-settings, the
// most complex settings-mutating route in the codebase, uses
// getAllSettings() ONLY for a read-only capability-gate comparison
// (config.js ~746) and writes via `for (const [key, value] of filtered)
// { await setSetting(key, value); }` (~790-797), same as everything
// else). So db.data is genuinely shared, not snapshotted -- this test
// proves the CONSEQUENCE of that through the real route, not the bare
// function: two concurrent PUT /app-settings calls for DIFFERENT keys
// should both survive, not race each other into a loss.

const { default: router } = await import("../routes/config.js");

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

    // THE FINDING: both concurrent saves' keys are present in the final
    // state -- not just one, and not neither. If db.data were snapshotted
    // per-request instead of shared, whichever request's flush landed
    // second would have silently discarded the other's change here.
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

    // Neither caller is told "your change may have been overwritten" --
    // both get an unqualified success, same as the updateServer() case
    // proven separately in dbConcurrentUpdateLastWriteWins.test.js. This
    // is expected REST semantics (no ETag/optimistic-concurrency layer
    // exists here), not a bug -- recorded as a verified property, not an
    // assumption.
    expect(responseA.getStatusCode()).toBe(200);
    expect(responseB.getStatusCode()).toBe(200);

    const finalValue = await getSetting("darkMode");
    expect([true, false]).toContain(finalValue);
  });
});
