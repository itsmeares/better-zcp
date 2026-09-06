// OIDC (OpenID Connect) sign-in — additive to local username/password login,
// never a replacement for it. Local login MUST keep working when OIDC is
// unconfigured, misconfigured, or the identity provider is unreachable: an
// operator locked out of the panel because a third-party IdP is down would
// mean losing control of their own game server.
//
// Uses openid-client (github.com/panva/openid-client), which wraps the
// lower-level oauth4webapi for all of discovery, PKCE, and — critically —
// ID token validation (signature via the provider's JWKS, issuer, audience,
// expiry, nonce). None of that crypto is reimplemented here.
//
// Scope, deliberately: ONE standards-compliant OIDC provider, configured by
// its issuer URL rather than hardcoding Google/Discord/etc. Authorization
// Code flow with PKCE. Every authorization request also carries and checks a
// nonce, even though the spec only requires that for the implicit flow —
// belt-and-braces per the operator's "good security" ask.
import * as client from "openid-client";
import { createLogger } from "../utils/logger.js";
import { getSetting, setSetting } from "../database/init.js";
import { readUiSecretFile, writeUiSecretFile } from "../utils/uiSecretFile.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import { ErrorCode } from "../utils/errorCodes.js";

const log = createLogger("OIDC");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

// The six non-secret fields, keyed by [envVar, dbSettingKey, defaultValue].
// clientSecret is handled separately below — it's UI-entered like the
// Discord bot token/Steam session cookie, so it lives in its own sibling
// file via utils/uiSecretFile.js rather than db.json (same reasoning as
// those: not panel-generated like jwt.secret, so it must stay editable
// through Settings, but a credential all the same).
const ENV_BACKED_FIELDS = [
  ["PANEL_OIDC_ISSUER_URL", "oidcIssuerUrl", ""],
  ["PANEL_OIDC_CLIENT_ID", "oidcClientId", ""],
  ["PANEL_OIDC_REDIRECT_URI", "oidcRedirectUri", ""],
  ["PANEL_OIDC_SCOPE", "oidcScope", "openid email profile"],
  // Optional, cosmetic only (e.g. "Sign in with Authentik" on a future
  // login button) — never used for any security decision.
  ["PANEL_OIDC_PROVIDER_NAME", "oidcProviderName", "SSO"],
];

/**
 * Resolves stored + env-backed OIDC settings. An env var, when set, WINS
 * over whatever is stored in the DB/secret file for that specific field —
 * an operator who has set one in the environment (Docker/systemd/compose)
 * is making a deployment-level choice that a UI edit must not silently
 * override. Each of the 7 fields is resolved independently, so an operator
 * can fix everything through the UI except the one field they deliberately
 * pinned via env.
 */
export async function getOidcSettings() {
  const resolved = {};
  for (const [envVar, settingKey, defaultValue] of ENV_BACKED_FIELDS) {
    const envValue = readEnv(envVar);
    if (envValue) {
      resolved[settingKey] = envValue;
    } else {
      const stored = await getSetting(settingKey);
      resolved[settingKey] =
        typeof stored === "string" && stored ? stored : defaultValue;
    }
  }

  const envClientSecret = readEnv("PANEL_OIDC_CLIENT_SECRET");
  const clientSecret =
    envClientSecret || readUiSecretFile("oidcClientSecret", log) || "";

  const envAllowInsecureHttp = readEnv("PANEL_OIDC_ALLOW_INSECURE_HTTP");
  // Off by default: openid-client refuses plain HTTP for discovery and
  // every subsequent request, which is the right default for a panel
  // exposed to the internet. Only needed for a self-hosted IdP reachable
  // solely over a private HTTP-only origin (e.g. behind a VPN/reverse
  // proxy that terminates TLS elsewhere) — and for this module's own
  // tests, which run a local HTTP mock IdP.
  const allowInsecureHttp = envAllowInsecureHttp
    ? envAllowInsecureHttp === "true"
    : Boolean(await getSetting("oidcAllowInsecureHttp"));

  return {
    issuerUrl: resolved.oidcIssuerUrl,
    clientId: resolved.oidcClientId,
    clientSecret,
    redirectUri: resolved.oidcRedirectUri,
    scope: resolved.oidcScope,
    providerName: resolved.oidcProviderName,
    allowInsecureHttp,
  };
}

/**
 * Return the fields pinned by environment variables so the settings UI can
 * explain why those values are not editable.
 */
export function getOidcEnvOverrides() {
  const overrides = {};
  for (const [envVar, settingKey] of ENV_BACKED_FIELDS) {
    overrides[settingKey.replace(/^oidc/, "").replace(/^./, (c) => c.toLowerCase())] =
      Boolean(readEnv(envVar));
  }
  overrides.clientSecret = Boolean(readEnv("PANEL_OIDC_CLIENT_SECRET"));
  overrides.allowInsecureHttp = Boolean(readEnv("PANEL_OIDC_ALLOW_INSECURE_HTTP"));
  return overrides;
}

export async function setOidcSettings(updates) {
  if (updates.issuerUrl !== undefined) await setSetting("oidcIssuerUrl", updates.issuerUrl);
  if (updates.clientId !== undefined) await setSetting("oidcClientId", updates.clientId);
  if (updates.redirectUri !== undefined) await setSetting("oidcRedirectUri", updates.redirectUri);
  if (updates.scope !== undefined) await setSetting("oidcScope", updates.scope);
  if (updates.providerName !== undefined) await setSetting("oidcProviderName", updates.providerName);
  if (updates.allowInsecureHttp !== undefined) await setSetting("oidcAllowInsecureHttp", updates.allowInsecureHttp);
  if (updates.clientSecret !== undefined) writeUiSecretFile("oidcClientSecret", updates.clientSecret);
}

export function isOidcConfigured(settings) {
  return Boolean(
    settings.issuerUrl &&
      settings.clientId &&
      settings.clientSecret &&
      settings.redirectUri,
  );
}

// Discovery is a network call to the IdP — never do it at module import time
// (that would make the whole panel's startup depend on a third-party
// service being reachable). Memoized so concurrent requests don't each
// trigger their own discovery round trip, but a FAILED discovery is not
// cached: an IdP that's down right now and reachable a minute from now
// should self-heal on the next login attempt rather than staying broken
// until the panel restarts.
let _configPromise = null;

export async function getOidcConfig() {
  const settings = await getOidcSettings();
  if (!isOidcConfigured(settings)) return null;

  if (!_configPromise) {
    // enableNonRepudiationChecks is REQUIRED here, not optional: by default
    // openid-client treats the token endpoint's TLS connection itself as
    // sufficient proof of the ID token's authenticity for the authorization
    // code flow, and skips verifying its JWS signature against the
    // provider's JWKS. That default is spec-compliant, but the operator
    // explicitly asked for "good security", and a wrong or missing check
    // here is exactly the kind of silent gap that's worse than not having
    // OIDC at all — so this always verifies the signature independently of
    // the TLS channel, belt-and-braces.
    const execute = [client.enableNonRepudiationChecks];
    if (settings.allowInsecureHttp) execute.push(client.allowInsecureRequests);

    _configPromise = client
      .discovery(
        new URL(settings.issuerUrl),
        settings.clientId,
        settings.clientSecret,
        undefined,
        { execute },
      )
      .catch((error) => {
        _configPromise = null;
        log.warn(`OIDC discovery against ${settings.issuerUrl} failed: ${error.message}`);
        throw error;
      });
  }
  return _configPromise;
}

// Forces the next getOidcConfig() call to re-run discovery instead of
// reusing a memoized Configuration. MUST be called by the settings save
// path (see routes/oidc.js's PUT /settings) -- without this, the trap is:
// an operator corrects a wrong issuer URL or rotates the client secret,
// the save reports success, and the panel keeps authenticating against
// the OLD provider config until the process restarts, because a
// discovery that never fails never re-runs. Previously only a FAILED
// discovery cleared this cache; a successful SAVE must clear it too.
export function resetOidcConfigCache() {
  _configPromise = null;
}

// Same function, kept under its original name so existing tests don't need
// to change -- this IS the real, non-test-only cache reset now.
export const _resetOidcConfigCacheForTests = resetOidcConfigCache;

// Reduces a discovered Configuration down to what the Settings screen shows
// the operator after a successful test -- concrete endpoints and advertised
// scopes to compare against the provider's own admin screen, rather than a
// success implied by nothing more than a green checkmark.
function describeDiscoveredMetadata(config) {
  const metadata = config.serverMetadata();
  return {
    issuer: metadata.issuer,
    authorizationEndpoint: metadata.authorization_endpoint || null,
    tokenEndpoint: metadata.token_endpoint || null,
    userinfoEndpoint: metadata.userinfo_endpoint || null,
    jwksUri: metadata.jwks_uri || null,
    scopesSupported: Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported : [],
  };
}

/**
 * Runs discovery against a CANDIDATE config the operator is about to save,
 * without touching the live memoized Configuration and without requiring a
 * full login round trip -- lets Settings offer a "Test Connection" button
 * that answers "is this issuer URL/client reachable and does it look like
 * a real OIDC provider" before the operator commits to it. providerName is
 * irrelevant to discovery/auth itself, so it's not accepted here.
 *
 * Discovery alone is NOT a credential test: it's an unauthenticated GET of
 * /.well-known/openid-configuration that takes clientId/clientSecret only
 * to build a Configuration object and never sends either anywhere. A wrong
 * client secret passes. A wrong client ID passes. An unregistered redirect
 * URI passes. Everything that actually breaks a real login goes untested,
 * and the operator finds out by signing out and landing in a failed
 * redirect. So after discovery succeeds, this also makes ONE token-endpoint
 * round trip with a deliberately bogus authorization code:
 *   - a provider that rejects the CLIENT answers `invalid_client`
 *   - a provider that accepts the client and only rejects the (fabricated)
 *     code answers `invalid_grant` -- so invalid_grant is the SUCCESS
 *     signal here, counter-intuitive enough to deserve this comment.
 * Keyed on the OAuth `error` CODE in the JSON body, never the HTTP status:
 * providers disagree on whether invalid_client is 401 or 400, and matching
 * on status would be flaky across exactly the providers we most want to
 * support. Any third outcome -- network failure, an HTML error page, an
 * OAuth error code we don't recognise -- is reported as `undetermined`,
 * never as success. A test that cannot fail is the bug this exists to fix;
 * this must not become a second one.
 */
export async function testOidcDiscovery({
  issuerUrl,
  clientId,
  clientSecret,
  redirectUri,
  allowInsecureHttp,
}) {
  if (!issuerUrl || !clientId || !clientSecret) {
    return {
      success: false,
      error: "issuerUrl, clientId and clientSecret are all required to test a connection.",
    };
  }

  let issuer;
  try {
    issuer = new URL(issuerUrl);
  } catch {
    return { success: false, error: "issuerUrl is not a valid URL." };
  }

  const execute = [client.enableNonRepudiationChecks];
  if (allowInsecureHttp) execute.push(client.allowInsecureRequests);

  let config;
  try {
    config = await client.discovery(issuer, clientId, clientSecret, undefined, { execute });
  } catch (error) {
    log.warn(`OIDC test-connection discovery against ${issuerUrl} failed: ${error.message}`);
    return { success: false, error: error.message };
  }

  const bogusCode = `zcp-test-connection-${client.randomState()}`;
  try {
    await client.genericGrantRequest(config, "authorization_code", {
      code: bogusCode,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    });
    // A provider that accepts a code it never issued, without even
    // rejecting the client, is not spec-compliant -- but credentials still
    // weren't the reason for the (lack of) failure, so treat it the same
    // as invalid_grant.
    return { success: true, metadata: describeDiscoveredMetadata(config) };
  } catch (error) {
    if (error instanceof client.ResponseBodyError) {
      if (error.error === "invalid_grant") {
        return { success: true, metadata: describeDiscoveredMetadata(config) };
      }
      if (error.error === "invalid_client") {
        return {
          success: false,
          code: ErrorCode.OIDC_CREDENTIALS_REJECTED,
          error:
            "The provider rejected the client ID or client secret. Double-check both against the identity provider's admin screen.",
        };
      }
      log.warn(
        `OIDC test-connection credential check against ${issuerUrl} got an unrecognised OAuth error: ${error.error}`,
      );
      return {
        success: false,
        code: ErrorCode.OIDC_TEST_UNDETERMINED,
        error: `The issuer is reachable, but its response ("${error.error}") doesn't confirm whether the credentials are valid. Try signing in for a definitive answer.`,
        params: sanitizeErrorParams({ reason: sanitizeError(error.error) }),
      };
    }
    log.warn(
      `OIDC test-connection credential check against ${issuerUrl} failed outside the OAuth error shape: ${error.message}`,
    );
    return {
      success: false,
      code: ErrorCode.OIDC_TEST_UNDETERMINED,
      error: `The issuer is reachable, but the credential check itself failed unexpectedly: ${error.message}`,
      params: sanitizeErrorParams({ reason: sanitizeError(error.message) }),
    };
  }
}

// ---------------------------------------------------------------------------
// Authorization request (the "log in with SSO" redirect)
// ---------------------------------------------------------------------------

/**
 * Builds the URL to send the browser to at the IdP, plus the PKCE/state/
 * nonce values the caller must persist (e.g. in a short-lived cookie) and
 * hand back to `handleOidcCallback` unchanged.
 */
export async function buildOidcAuthorizationRequest() {
  const config = await getOidcConfig();
  if (!config) {
    throw new Error("OIDC is not configured");
  }
  const settings = await getOidcSettings();

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: settings.redirectUri,
    scope: settings.scope,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });

  return { authorizationUrl: url.href, state, nonce, codeVerifier };
}

// ---------------------------------------------------------------------------
// Callback (the redirect back from the IdP)
// ---------------------------------------------------------------------------

/**
 * `currentUrl` must be a URL whose origin+pathname equal the configured
 * redirect_uri and whose query string is exactly what the IdP sent back
 * (code, state, or error) — see routes/oidc.js for how that's built from
 * the incoming request. `flow` is the { state, nonce, codeVerifier } this
 * module handed back from buildOidcAuthorizationRequest and the caller
 * persisted across the redirect.
 *
 * Resolves to the VALIDATED ID token claims (signature, issuer, audience,
 * expiry, and nonce all already checked by openid-client/oauth4webapi) on
 * success. Throws on any validation failure, including the IdP itself
 * reporting an error (e.g. the user denied consent) — callers must not
 * treat a caught exception here as anything other than "not authenticated".
 */
export async function handleOidcCallback(currentUrl, flow) {
  const config = await getOidcConfig();
  if (!config) {
    throw new Error("OIDC is not configured");
  }
  if (!flow || !flow.state || !flow.nonce || !flow.codeVerifier) {
    throw new Error("OIDC sign-in session is missing or expired");
  }

  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: flow.codeVerifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    idTokenExpected: true,
  });

  // Already fully validated by authorizationCodeGrant above (signature via
  // the provider's JWKS, iss, aud, exp, and nonce) — this just reads the
  // result out, it performs no additional checking of its own.
  const claims = tokens.claims();
  if (!claims || !claims.sub) {
    throw new Error("OIDC provider did not return a subject claim");
  }

  return claims;
}
