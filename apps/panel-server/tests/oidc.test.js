import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'http';
import {
  getOidcSettings,
  isOidcConfigured,
  getOidcConfig,
  buildOidcAuthorizationRequest,
  handleOidcCallback,
  _resetOidcConfigCacheForTests,
} from '../services/oidc.js';
import { makeSigningKey, startMockOidcProvider } from './helpers/mockOidcProvider.js';

const ENV_KEYS = [
  'PANEL_OIDC_ISSUER_URL',
  'PANEL_OIDC_CLIENT_ID',
  'PANEL_OIDC_CLIENT_SECRET',
  'PANEL_OIDC_REDIRECT_URI',
  'PANEL_OIDC_SCOPE',
  'PANEL_OIDC_PROVIDER_NAME',
  'PANEL_OIDC_ALLOW_INSECURE_HTTP',
];

function clearOidcEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
  _resetOidcConfigCacheForTests();
}

describe('OIDC: unconfigured (the non-negotiable property)', () => {
  beforeEach(clearOidcEnv);
  afterEach(clearOidcEnv);

  it('reports not configured with no env vars set', async () => {
    expect(isOidcConfigured(await getOidcSettings())).toBe(false);
  });

  it('reports not configured when only some env vars are set', async () => {
    process.env.PANEL_OIDC_ISSUER_URL = 'https://idp.example.com';
    process.env.PANEL_OIDC_CLIENT_ID = 'panel';
    // client secret and redirect URI intentionally left unset
    expect(isOidcConfigured(await getOidcSettings())).toBe(false);
  });

  it('getOidcConfig() resolves to null rather than throwing or making a network call', async () => {
    await expect(getOidcConfig()).resolves.toBeNull();
  });

  it('buildOidcAuthorizationRequest() fails clearly instead of crashing the caller', async () => {
    await expect(buildOidcAuthorizationRequest()).rejects.toThrow(/not configured/i);
  });

  it('handleOidcCallback() fails clearly instead of crashing the caller', async () => {
    await expect(
      handleOidcCallback(new URL('https://panel.example.com/api/auth/oidc/callback'), {
        state: 'x',
        nonce: 'y',
        codeVerifier: 'z',
      }),
    ).rejects.toThrow(/not configured/i);
  });

  it('module import itself never touches the network — settings are read lazily per call, not cached at import time', async () => {
    // If this module made a network call (or read env vars) at import time,
    // it would have already happened by the time this test file's imports
    // resolved, long before any env var was set above. Re-reading settings
    // here and getting the CURRENT env proves reads are lazy per call.
    process.env.PANEL_OIDC_PROVIDER_NAME = 'Just Set This';
    expect((await getOidcSettings()).providerName).toBe('Just Set This');
  });
});

describe('OIDC: ID token validation (each rejection reason tested separately)', () => {
  let provider;
  let unpublishedKey; // NOT published in JWKS -- signatures with this key must fail.

  const CLIENT_ID = 'panel-test-client';
  const CLIENT_SECRET = 'panel-test-secret';
  const REDIRECT_URI_PATH = '/api/auth/oidc/callback';

  beforeAll(async () => {
    provider = await startMockOidcProvider({ clientId: CLIENT_ID, defaultSubject: 'user-123' });
    unpublishedKey = await makeSigningKey();
  });

  afterAll(async () => {
    await provider.close();
  });

  beforeEach(() => {
    process.env.PANEL_OIDC_ISSUER_URL = provider.baseUrl;
    process.env.PANEL_OIDC_CLIENT_ID = CLIENT_ID;
    process.env.PANEL_OIDC_CLIENT_SECRET = CLIENT_SECRET;
    process.env.PANEL_OIDC_REDIRECT_URI = `${provider.baseUrl}${REDIRECT_URI_PATH}`;
    process.env.PANEL_OIDC_ALLOW_INSECURE_HTTP = 'true'; // local mock IdP is plain HTTP
    _resetOidcConfigCacheForTests();
    provider.setNextIdToken({});
  });

  afterEach(clearOidcEnv);

  // Drives a callback exactly the way routes/oidc.js does: a flow (state,
  // nonce, codeVerifier) plus a currentUrl carrying ?code=...&state=....
  async function runCallback({ state = 'flow-state', nonce = 'flow-nonce' } = {}) {
    const flow = { state, nonce, codeVerifier: 'flow-code-verifier' };
    const currentUrl = new URL(`${provider.baseUrl}${REDIRECT_URI_PATH}`);
    currentUrl.searchParams.set('code', 'test-authorization-code');
    currentUrl.searchParams.set('state', state);
    return handleOidcCallback(currentUrl, flow);
  }

  it('accepts a correctly-signed token with correct issuer, audience, expiry, and nonce', async () => {
    provider.setNextIdToken({ claims: { nonce: 'flow-nonce' } });
    const claims = await runCallback();
    expect(claims.sub).toBe('user-123');
    expect(claims.iss).toBe(provider.baseUrl);
    expect(claims.aud).toBe(CLIENT_ID);
  });

  it('rejects a token signed with a key not published in the JWKS (bad signature)', async () => {
    provider.setNextIdToken({ claims: { nonce: 'flow-nonce' }, signingKey: unpublishedKey });
    await expect(runCallback()).rejects.toThrow();
  });

  it('rejects a token whose issuer does not match the discovered issuer', async () => {
    provider.setNextIdToken({
      claims: { nonce: 'flow-nonce', iss: 'https://not-the-real-idp.example.com' },
    });
    await expect(runCallback()).rejects.toThrow();
  });

  it('rejects a token whose audience does not match this client', async () => {
    provider.setNextIdToken({ claims: { nonce: 'flow-nonce', aud: 'some-other-client' } });
    await expect(runCallback()).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    provider.setNextIdToken({ claims: { nonce: 'flow-nonce', iat: now - 3600, exp: now - 1800 } });
    await expect(runCallback()).rejects.toThrow();
  });

  it('rejects a token whose nonce does not match the one sent in the authorization request', async () => {
    provider.setNextIdToken({ claims: { nonce: 'a-completely-different-nonce' } });
    await expect(runCallback()).rejects.toThrow();
  });

  it('rejects a token with no nonce at all when a nonce was required', async () => {
    provider.setNextIdToken({}); // no `nonce` override -- the base claims object has none either
    await expect(runCallback()).rejects.toThrow();
  });

  it('rejects the whole callback when the state does not match (CSRF protection)', async () => {
    provider.setNextIdToken({ claims: { nonce: 'flow-nonce' } });
    const flow = { state: 'flow-state', nonce: 'flow-nonce', codeVerifier: 'flow-code-verifier' };
    const currentUrl = new URL(`${provider.baseUrl}${REDIRECT_URI_PATH}`);
    currentUrl.searchParams.set('code', 'test-authorization-code');
    currentUrl.searchParams.set('state', 'an-attacker-supplied-different-state');
    await expect(handleOidcCallback(currentUrl, flow)).rejects.toThrow();
  });

  it('a validation failure never returns partial/unvalidated claims -- it throws, full stop', async () => {
    const now = Math.floor(Date.now() / 1000);
    provider.setNextIdToken({ claims: { nonce: 'flow-nonce', iat: now - 3600, exp: now - 1800 } });
    let threw = false;
    let result;
    try {
      result = await runCallback();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(result).toBeUndefined();
  });
});

describe('OIDC: discovery failure does not stick around forever', () => {
  beforeEach(clearOidcEnv);
  afterEach(clearOidcEnv);

  it('a failed discovery is retried (not permanently cached) once the issuer is reachable again', async () => {
    // Point at a port nothing is listening on.
    process.env.PANEL_OIDC_ISSUER_URL = 'http://127.0.0.1:1';
    process.env.PANEL_OIDC_CLIENT_ID = 'panel';
    process.env.PANEL_OIDC_CLIENT_SECRET = 'secret';
    process.env.PANEL_OIDC_REDIRECT_URI = 'https://panel.example.com/api/auth/oidc/callback';
    process.env.PANEL_OIDC_ALLOW_INSECURE_HTTP = 'true';

    await expect(getOidcConfig()).rejects.toThrow();

    // Now point at a real, working discovery document and confirm the
    // module doesn't keep returning the old failure forever.
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          issuer: process.env.PANEL_OIDC_ISSUER_URL,
          authorization_endpoint: `${process.env.PANEL_OIDC_ISSUER_URL}/authorize`,
          token_endpoint: `${process.env.PANEL_OIDC_ISSUER_URL}/token`,
          jwks_uri: `${process.env.PANEL_OIDC_ISSUER_URL}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      process.env.PANEL_OIDC_ISSUER_URL = `http://127.0.0.1:${address.port}`;

      await expect(getOidcConfig()).resolves.toBeTruthy();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
