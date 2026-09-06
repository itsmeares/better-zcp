import * as client from "openid-client";
import { createLogger } from "../utils/logger.js";
import { getSetting, setSetting } from "../database/init.js";
import { readUiSecretFile, writeUiSecretFile } from "../utils/uiSecretFile.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import { ErrorCode } from "../utils/errorCodes.js";

const log = createLogger("OIDC");


function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

const ENV_BACKED_FIELDS = [
  ["PANEL_OIDC_ISSUER_URL", "oidcIssuerUrl", ""],
  ["PANEL_OIDC_CLIENT_ID", "oidcClientId", ""],
  ["PANEL_OIDC_REDIRECT_URI", "oidcRedirectUri", ""],
  ["PANEL_OIDC_SCOPE", "oidcScope", "openid email profile"],
  ["PANEL_OIDC_PROVIDER_NAME", "oidcProviderName", "SSO"],
];

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

let _configPromise = null;

export async function getOidcConfig() {
  const settings = await getOidcSettings();
  if (!isOidcConfigured(settings)) return null;

  if (!_configPromise) {
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

export function resetOidcConfigCache() {
  _configPromise = null;
}

export const _resetOidcConfigCacheForTests = resetOidcConfigCache;

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

  const claims = tokens.claims();
  if (!claims || !claims.sub) {
    throw new Error("OIDC provider did not return a subject claim");
  }

  return claims;
}
