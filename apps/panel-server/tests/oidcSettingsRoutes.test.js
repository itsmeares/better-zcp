import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";
import { startMockOidcProvider } from "./helpers/mockOidcProvider.js";

// GET/PUT /api/auth/oidc/settings and POST /api/auth/oidc/test-connection --
// the OIDC-configurable-from-the-panel work. Two things this file exists
// specifically to prove, per the operator's own ruling:
//   1. clientSecret is NEVER echoed back by GET, not even masked -- only
//      whether it's configured.
//   2. THE TRAP: a PUT that saves new settings must make getOidcConfig()
//      re-run discovery against the NEW issuer, not keep serving a
//      memoized Configuration built from the OLD one. Without
//      resetOidcConfigCache() in the save path, this is exactly the "save
//      reports success, panel keeps using the old config until restart"
//      bug the whole feature exists to avoid.

const settingsStore = new Map();

vi.mock("../database/init.js", () => ({
  getRoleByName: mockGetRoleByName,
  getSetting: async (key) => settingsStore.get(key) ?? null,
  setSetting: async (key, value) => {
    settingsStore.set(key, value);
  },
}));

// Seeded with a real directory before the dynamic import below: importing
// services/oidc.js pulls in utils/logger.js, which calls getDataPaths()
// and mkdirSyncs a logs dir at MODULE IMPORT TIME -- tmpDir must already
// be a real path at that first import, not just non-undefined later.
let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-oidc-settings-seed-"));
vi.mock("../utils/paths.js", () => ({
  getDataPaths: () => ({ dataDir: tmpDir, logsDir: tmpDir }),
}));

const { default: oidcRouter } = await import("../routes/oidc.js");
const { resetOidcConfigCache, getOidcConfig } = await import("../services/oidc.js");

const ENV_KEYS = [
  "PANEL_OIDC_ISSUER_URL",
  "PANEL_OIDC_CLIENT_ID",
  "PANEL_OIDC_CLIENT_SECRET",
  "PANEL_OIDC_REDIRECT_URI",
  "PANEL_OIDC_SCOPE",
  "PANEL_OIDC_PROVIDER_NAME",
  "PANEL_OIDC_ALLOW_INSECURE_HTTP",
];
function clearOidcEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function getLayer(routePath, method) {
  return oidcRouter.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runRoute(routePath, method, req) {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  const layer = getLayer(routePath, method);
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

function makeReq({ body = {}, user = { role: "admin" }, protocol = "https", host = "panel.example.com" } = {}) {
  return {
    body,
    user,
    protocol,
    get: (name) => (name.toLowerCase() === "host" ? host : undefined),
  };
}

describe("gate: requirePermission('panel.settings'), both directions", () => {
  beforeEach(() => {
    settingsStore.clear();
    clearOidcEnv();
    resetOidcConfigCache();
  });

  it("GET /settings refuses a role without panel.settings", async () => {
    const res = await runRoute("/settings", "get", makeReq({ user: { role: "moderator" } }));
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("GET /settings admits a role with panel.settings", async () => {
    const res = await runRoute("/settings", "get", makeReq({ user: { role: "admin" } }));
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it("PUT /settings refuses a role without panel.settings", async () => {
    const res = await runRoute(
      "/settings",
      "put",
      makeReq({ user: { role: "moderator" }, body: { providerName: "x" } }),
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("POST /test-connection refuses a role without panel.settings", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({ user: { role: "moderator" } }),
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("GET /settings: clientSecret is never echoed back, not even masked", () => {
  beforeEach(() => {
    settingsStore.clear();
    clearOidcEnv();
    resetOidcConfigCache();
  });

  it("returns clientSecretConfigured:false and no clientSecret field when nothing is set", async () => {
    const res = await runRoute("/settings", "get", makeReq());
    const payload = res.json.mock.calls[0][0];
    expect(payload.clientSecretConfigured).toBe(false);
    expect(payload.clientSecret).toBeUndefined();
  });

  it("after a real secret is saved: reports clientSecretConfigured:true, STILL never the value", async () => {
    await runRoute(
      "/settings",
      "put",
      makeReq({ body: { clientSecret: "s3cr3t-value-do-not-leak" } }),
    );

    const res = await runRoute("/settings", "get", makeReq());
    const payload = res.json.mock.calls[0][0];
    expect(payload.clientSecretConfigured).toBe(true);
    expect(payload.clientSecret).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("s3cr3t-value-do-not-leak");
  });

  it("suggestedRedirectUri is derived from the actual request origin, not guessed from stored config", async () => {
    const res = await runRoute(
      "/settings",
      "get",
      makeReq({ protocol: "https", host: "my-panel.example.org:8443" }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.suggestedRedirectUri).toBe(
      "https://my-panel.example.org:8443/api/auth/oidc/callback",
    );
  });

  it("surfaces which fields are env-overridden", async () => {
    process.env.PANEL_OIDC_ISSUER_URL = "https://env-idp.example.com";
    const res = await runRoute("/settings", "get", makeReq());
    const payload = res.json.mock.calls[0][0];
    expect(payload.envOverrides.issuerUrl).toBe(true);
    expect(payload.envOverrides.clientId).toBe(false);
  });
});

describe("PUT /settings: validation", () => {
  beforeEach(() => {
    settingsStore.clear();
    clearOidcEnv();
    resetOidcConfigCache();
  });

  it("rejects a plain-http issuerUrl when allowInsecureHttp is not set", async () => {
    const res = await runRoute(
      "/settings",
      "put",
      makeReq({ body: { issuerUrl: "http://idp.internal" } }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(settingsStore.get("oidcIssuerUrl")).toBeUndefined();
  });

  it("accepts a plain-http issuerUrl when allowInsecureHttp is set in the SAME request", async () => {
    const res = await runRoute(
      "/settings",
      "put",
      makeReq({ body: { issuerUrl: "http://idp.internal", allowInsecureHttp: true } }),
    );
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it("rejects a malformed redirectUri", async () => {
    const res = await runRoute(
      "/settings",
      "put",
      makeReq({ body: { redirectUri: "not a url at all" } }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("a resubmitted masked clientSecret placeholder leaves the real stored secret untouched", async () => {
    await runRoute("/settings", "put", makeReq({ body: { clientSecret: "real-secret-1" } }));

    // Simulate the UI echoing back whatever GET showed it (never the real
    // value, but SOME masked-looking placeholder) alongside an unrelated field.
    await runRoute(
      "/settings",
      "put",
      makeReq({ body: { clientSecret: "••••••••1234", providerName: "Renamed" } }),
    );

    const settings = (await runRoute("/settings", "get", makeReq())).json.mock.calls[0][0];
    expect(settings.providerName).toBe("Renamed");
    expect(settings.clientSecretConfigured).toBe(true);
    // The only way to prove the ORIGINAL secret survived without reading it
    // back (which the route correctly never allows) is to check the file
    // on disk directly, once, in this one test.
    const stored = fs.readFileSync(path.join(tmpDir, "oidcClientSecret.secret"), "utf8");
    expect(stored).toBe("real-secret-1");
  });
});

describe("PUT /settings: a successful save actually takes effect without a restart (THE TRAP)", () => {
  let providerA;
  let providerB;

  beforeEach(async () => {
    settingsStore.clear();
    clearOidcEnv();
    resetOidcConfigCache();
    providerA = await startMockOidcProvider({ clientId: "client-a" });
    providerB = await startMockOidcProvider({ clientId: "client-b" });
  });

  afterEach(async () => {
    await providerA.close();
    await providerB.close();
  });

  it("getOidcConfig() reflects a saved change immediately, not after a restart", async () => {
    await runRoute(
      "/settings",
      "put",
      makeReq({
        body: {
          issuerUrl: providerA.baseUrl,
          clientId: "client-a",
          clientSecret: "secret-a",
          redirectUri: `${providerA.baseUrl}/api/auth/oidc/callback`,
          allowInsecureHttp: true,
        },
      }),
    );

    const configA = await getOidcConfig();
    expect(configA.serverMetadata().issuer).toBe(providerA.baseUrl);

    // Now save a DIFFERENT provider entirely -- the exact scenario an
    // operator correcting a wrong issuer URL, or rotating providers, hits.
    await runRoute(
      "/settings",
      "put",
      makeReq({
        body: {
          issuerUrl: providerB.baseUrl,
          clientId: "client-b",
          clientSecret: "secret-b",
          redirectUri: `${providerB.baseUrl}/api/auth/oidc/callback`,
          allowInsecureHttp: true,
        },
      }),
    );

    const configB = await getOidcConfig();
    expect(configB.serverMetadata().issuer).toBe(providerB.baseUrl);
    // If the trap were still present, this would still equal providerA's
    // issuer -- a stale memoized Configuration from before the save.
    expect(configB.serverMetadata().issuer).not.toBe(providerA.baseUrl);
  });
});

describe("POST /test-connection", () => {
  let provider;

  beforeEach(async () => {
    settingsStore.clear();
    clearOidcEnv();
    resetOidcConfigCache();
    provider = await startMockOidcProvider({ clientId: "test-client" });
  });

  afterEach(async () => {
    await provider.close();
  });

  it("succeeds against a real, reachable issuer, and does not persist anything", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: provider.baseUrl,
          clientId: "test-client",
          clientSecret: "whatever-secret",
          allowInsecureHttp: true,
        },
      }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    // bug hunt 2026-08-31-c (under-coverage sweep): the title claims nothing
    // is persisted at all, but this used to check only one specific key
    // (oidcIssuerUrl) out of the five persistable OIDC settings fields --
    // undercutting the actual promise the title makes. settingsStore is the
    // mocked setSetting() sink for every key this route could theoretically
    // write; asserting it stayed empty proves setSetting() was never called
    // at all, not just that one field happened to be untouched.
    expect(settingsStore.size).toBe(0);
  });

  it("fails against an unreachable issuer, with a reason rather than a thrown 500", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: "http://127.0.0.1:1",
          clientId: "test-client",
          clientSecret: "whatever-secret",
          allowInsecureHttp: true,
        },
      }),
    );
    expect(res.status).not.toHaveBeenCalledWith(500);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.error).toBeTruthy();
  });

  it("uses the already-saved clientSecret when the request omits it -- testing a partial edit doesn't require retyping the secret", async () => {
    await runRoute(
      "/settings",
      "put",
      makeReq({ body: { clientSecret: "already-saved-secret" } }),
    );

    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: provider.baseUrl,
          clientId: "test-client",
          allowInsecureHttp: true,
          // clientSecret deliberately omitted
        },
      }),
    );
    // The mock provider's discovery endpoint doesn't validate the secret at
    // all (see mockOidcProvider.js), so success here just proves the call
    // was made at all with SOME secret filled in rather than failing our
    // own "issuerUrl/clientId/clientSecret all required" pre-check.
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
  });
});

// The headline bug this whole feature exists to fix: discovery alone is an
// unauthenticated GET that never sends clientId/clientSecret anywhere, so a
// wrong secret, wrong client ID, or unregistered redirect URI all silently
// passed the old test. These prove the credential round trip actually
// distinguishes "the provider rejected the client" from "the provider
// accepted the client and only rejected our fabricated code" (the success
// signal) from a third, genuinely ambiguous outcome.
describe("POST /test-connection -- credential check (strictAuth mock)", () => {
  let provider;

  beforeEach(async () => {
    settingsStore.clear();
    clearOidcEnv();
    resetOidcConfigCache();
    provider = await startMockOidcProvider({
      clientId: "real-client",
      strictAuth: { clientSecret: "real-secret" },
    });
  });

  afterEach(async () => {
    await provider.close();
  });

  it("succeeds AND returns the discovered endpoints/scopes when the client authenticates but the fabricated code is rejected (invalid_grant)", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: provider.baseUrl,
          clientId: "real-client",
          clientSecret: "real-secret",
          allowInsecureHttp: true,
        },
      }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.metadata).toEqual({
      issuer: provider.baseUrl,
      authorizationEndpoint: `${provider.baseUrl}/authorize`,
      tokenEndpoint: `${provider.baseUrl}/token`,
      userinfoEndpoint: null,
      jwksUri: `${provider.baseUrl}/jwks`,
      scopesSupported: [],
    });
  });

  it("reports credentials_rejected, not a generic failure, when the client secret is wrong (invalid_client)", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: provider.baseUrl,
          clientId: "real-client",
          clientSecret: "totally-wrong-secret",
          allowInsecureHttp: true,
        },
      }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.code).toBe("OIDC_CREDENTIALS_REJECTED");
  });

  it("reports credentials_rejected when the client ID is wrong (invalid_client)", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: provider.baseUrl,
          clientId: "wrong-client-id",
          clientSecret: "real-secret",
          allowInsecureHttp: true,
        },
      }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.code).toBe("OIDC_CREDENTIALS_REJECTED");
  });

  it("reports undetermined, not success, for an OAuth error code that is neither invalid_grant nor invalid_client", async () => {
    provider.setNextGrantError({
      status: 400,
      error: "invalid_request",
      error_description: "redirect_uri is required for this client.",
    });
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: provider.baseUrl,
          clientId: "real-client",
          clientSecret: "real-secret",
          allowInsecureHttp: true,
        },
      }),
    );
    const payload = res.json.mock.calls[0][0];
    // The important assertion: this must NOT be reported as success just
    // because discovery worked and the client wasn't explicitly rejected.
    expect(payload.success).toBe(false);
    expect(payload.code).toBe("OIDC_TEST_UNDETERMINED");
  });

  it("keying on the OAuth error code, not the HTTP status, still recognises invalid_client when a provider answers 400 instead of 401", async () => {
    provider.setNextGrantError({
      status: 400,
      error: "invalid_client",
      error_description: "Client authentication failed.",
    });
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: provider.baseUrl,
          clientId: "real-client",
          clientSecret: "real-secret",
          allowInsecureHttp: true,
        },
      }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.code).toBe("OIDC_CREDENTIALS_REJECTED");
  });
});
