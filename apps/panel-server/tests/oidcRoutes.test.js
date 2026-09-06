import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import authService from '../services/auth.js';
import * as dbModule from '../database/init.js';
import { _resetOidcConfigCacheForTests } from '../services/oidc.js';
import oidcRoutes from '../routes/oidc.js';
import { startMockOidcProvider } from './helpers/mockOidcProvider.js';

const ENV_KEYS = [
  'PANEL_OIDC_ISSUER_URL',
  'PANEL_OIDC_CLIENT_ID',
  'PANEL_OIDC_CLIENT_SECRET',
  'PANEL_OIDC_REDIRECT_URI',
  'PANEL_OIDC_ALLOW_INSECURE_HTTP',
];

function clearOidcEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
  _resetOidcConfigCacheForTests();
}

// Finds a route's handler function directly on the Express Router, the same
// way the router itself would dispatch to it, without needing to spin up a
// real HTTP server (this codebase's tests don't use supertest anywhere, and
// adding it just for these routes would be a second new test-only
// dependency on top of the ones this OIDC work already needed).
function getHandler(method, path) {
  const layer = oidcRoutes.stack.find(
    (l) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeReq({ cookies = {}, url = '/', headers = {}, secure = false } = {}) {
  return { cookies, url, headers, secure };
}

function makeRes() {
  const res = {
    statusCode: 200,
    jsonBody: undefined,
    redirectedTo: undefined,
    cookies: [],
    clearedCookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
    redirect(url) {
      this.redirectedTo = url;
      return this;
    },
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
      return this;
    },
    clearCookie(name, options) {
      this.clearedCookies.push({ name, options });
      return this;
    },
  };
  return res;
}

describe('routes/oidc.js: /status', () => {
  beforeEach(clearOidcEnv);
  afterEach(clearOidcEnv);

  it('reports unconfigured with no env vars set', async () => {
    const res = makeRes();
    await getHandler('get', '/status')(makeReq(), res);
    expect(res.jsonBody).toEqual({ configured: false, providerName: 'SSO' });
  });

  it('reports configured once all required env vars are set', async () => {
    process.env.PANEL_OIDC_ISSUER_URL = 'https://idp.example.com';
    process.env.PANEL_OIDC_CLIENT_ID = 'panel';
    process.env.PANEL_OIDC_CLIENT_SECRET = 'secret';
    process.env.PANEL_OIDC_REDIRECT_URI = 'https://panel.example.com/api/auth/oidc/callback';

    const res = makeRes();
    await getHandler('get', '/status')(makeReq(), res);
    expect(res.jsonBody.configured).toBe(true);
  });
});

describe('routes/oidc.js: /login', () => {
  beforeEach(clearOidcEnv);
  afterEach(clearOidcEnv);

  it('returns 404 rather than crashing when OIDC is not configured', async () => {
    const res = makeRes();
    await getHandler('get', '/login')(makeReq(), res);
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody).toEqual({ error: 'OIDC is not configured' });
    expect(res.redirectedTo).toBeUndefined();
  });

  it('when configured: redirects to the provider and sets a Lax, path-scoped flow cookie', async () => {
    const provider = await startMockOidcProvider({ clientId: 'panel-test-client' });
    try {
      process.env.PANEL_OIDC_ISSUER_URL = provider.baseUrl;
      process.env.PANEL_OIDC_CLIENT_ID = 'panel-test-client';
      process.env.PANEL_OIDC_CLIENT_SECRET = 'panel-test-secret';
      process.env.PANEL_OIDC_REDIRECT_URI = `${provider.baseUrl}/api/auth/oidc/callback`;
      process.env.PANEL_OIDC_ALLOW_INSECURE_HTTP = 'true';
      _resetOidcConfigCacheForTests();

      const res = makeRes();
      await getHandler('get', '/login')(makeReq(), res);

      expect(res.redirectedTo).toContain(`${provider.baseUrl}/authorize`);
      expect(res.cookies).toHaveLength(1);
      expect(res.cookies[0].name).toBe('oidcFlow');
      expect(res.cookies[0].options.httpOnly).toBe(true);
      expect(res.cookies[0].options.sameSite).toBe('lax');
      expect(res.cookies[0].options.path).toBe('/api/auth/oidc');
      const flow = JSON.parse(res.cookies[0].value);
      expect(flow.state).toEqual(expect.any(String));
      expect(flow.nonce).toEqual(expect.any(String));
      expect(flow.codeVerifier).toEqual(expect.any(String));
    } finally {
      await provider.close();
    }
  });

  it('when the provider is unreachable: responds 502 instead of hanging or crashing the process', async () => {
    process.env.PANEL_OIDC_ISSUER_URL = 'http://127.0.0.1:1';
    process.env.PANEL_OIDC_CLIENT_ID = 'panel';
    process.env.PANEL_OIDC_CLIENT_SECRET = 'secret';
    process.env.PANEL_OIDC_REDIRECT_URI = 'https://panel.example.com/api/auth/oidc/callback';
    process.env.PANEL_OIDC_ALLOW_INSECURE_HTTP = 'true';
    _resetOidcConfigCacheForTests();

    const res = makeRes();
    await getHandler('get', '/login')(makeReq(), res);
    expect(res.statusCode).toBe(502);
    expect(res.redirectedTo).toBeUndefined();
  });
});

describe('routes/oidc.js: /callback', () => {
  let provider;
  const CLIENT_ID = 'panel-test-client';
  const CLIENT_SECRET = 'panel-test-secret';
  const REDIRECT_URI_PATH = '/api/auth/oidc/callback';
  const SUBJECT = 'user-123';

  beforeAll(async () => {
    provider = await startMockOidcProvider({ clientId: CLIENT_ID, defaultSubject: SUBJECT });
  });

  afterAll(async () => {
    await provider.close();
  });

  beforeEach(() => {
    process.env.PANEL_OIDC_ISSUER_URL = provider.baseUrl;
    process.env.PANEL_OIDC_CLIENT_ID = CLIENT_ID;
    process.env.PANEL_OIDC_CLIENT_SECRET = CLIENT_SECRET;
    process.env.PANEL_OIDC_REDIRECT_URI = `${provider.baseUrl}${REDIRECT_URI_PATH}`;
    process.env.PANEL_OIDC_ALLOW_INSECURE_HTTP = 'true';
    _resetOidcConfigCacheForTests();
    provider.setNextIdToken({});
  });

  afterEach(() => {
    clearOidcEnv();
    vi.restoreAllMocks();
  });

  function callbackReq({ state = 'flow-state', nonce = 'flow-nonce', missingCookie = false } = {}) {
    return makeReq({
      cookies: missingCookie
        ? {}
        : { oidcFlow: JSON.stringify({ state, nonce, codeVerifier: 'flow-code-verifier' }) },
      url: `${REDIRECT_URI_PATH}?code=test-code&state=${state}`,
    });
  }

  it('redirects with not_configured when OIDC is unconfigured, and never touches the flow cookie', async () => {
    clearOidcEnv();
    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq(), res);
    expect(res.redirectedTo).toBe('/?oidcError=not_configured');
    // The title's second claim ("never touches the flow cookie") had no
    // assertion of its own -- bug hunt 2026-08-31, mechanical sweep for
    // tests whose own name promises more than their body checks. The
    // not_configured branch returns before the route's later
    // res.clearCookie(FLOW_COOKIE_NAME, ...) call, so this must stay empty.
    expect(res.clearedCookies).toHaveLength(0);
  });

  it('redirects with expired_flow when the flow cookie is missing, and clears it defensively either way', async () => {
    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq({ missingCookie: true }), res);
    expect(res.redirectedTo).toBe('/?oidcError=expired_flow');
    expect(res.clearedCookies).toHaveLength(1);
    expect(res.clearedCookies[0].name).toBe('oidcFlow');
  });

  it('redirects with invalid_token when the ID token fails validation, and never reaches user resolution', async () => {
    provider.setNextIdToken({ claims: { nonce: 'wrong-nonce-entirely' } });
    const getDbSpy = vi.spyOn(dbModule, 'getDb');

    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq(), res);

    expect(res.redirectedTo).toBe('/?oidcError=invalid_token');
    // authService.loginWithExternalIdentity's first move is db.data.users --
    // if the token had reached it, getDb() would have been called.
    expect(getDbSpy).not.toHaveBeenCalled();
  });

  it('redirects with refused when the identity is not linked to any account on an already-initialized panel', async () => {
    provider.setNextIdToken({ claims: { nonce: 'flow-nonce' } });
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({
      data: {
        users: [
          { id: 'existing-1', username: 'admin', role: 'admin', externalIdentities: [] },
        ],
      },
    });

    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq(), res);

    expect(res.redirectedTo).toBe('/?oidcError=refused');
    expect(res.cookies.find((c) => c.name === 'refreshToken')).toBeUndefined();
  });

  it('redirects with setup_required (not an auto-created account) when the identity is unlinked on a brand new panel', async () => {
    provider.setNextIdToken({ claims: { nonce: 'flow-nonce' } });
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({ data: { users: [] } });

    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq(), res);

    expect(res.redirectedTo).toBe('/?oidcError=setup_required');
    expect(res.cookies.find((c) => c.name === 'refreshToken')).toBeUndefined();
  });

  it('on success: issues a session cookie identical in shape to local login and redirects to /', async () => {
    provider.setNextIdToken({ claims: { nonce: 'flow-nonce' } });
    authService.jwtSecret = 'test-oidc-route-secret';
    vi.spyOn(dbModule, 'commitNow').mockResolvedValue(undefined);
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({
      data: {
        users: [
          {
            id: 'user-42',
            username: 'sso.alice',
            role: 'moderator',
            tokenGen: 0,
            refreshSessions: [],
            externalIdentities: [{ issuer: provider.baseUrl, subject: SUBJECT }],
          },
        ],
      },
    });

    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq(), res);

    expect(res.redirectedTo).toBe('/');
    const refreshCookie = res.cookies.find((c) => c.name === 'refreshToken');
    expect(refreshCookie).toBeTruthy();
    expect(refreshCookie.options.httpOnly).toBe(true);
    expect(refreshCookie.options.sameSite).toBe('strict');
    expect(refreshCookie.options.path).toBe('/api/auth');
    // The session must be genuinely usable by the rest of the app: verify
    // with the SAME secret authService signed it with that the cookie is a
    // real, validly-signed refresh token for this user, not just that SOME
    // cookie was set. (authService.verifyAccessToken() deliberately refuses
    // refresh-typed tokens -- token-type confusion guard -- so this uses
    // jwt.verify directly, the same way authService.refreshAccessToken()
    // itself validates a refresh token.)
    const decoded = jwt.verify(refreshCookie.value, authService.jwtSecret);
    expect(decoded.type).toBe('refresh');
    expect(decoded.userId).toBe('user-42');
  });
});
