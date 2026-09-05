// OIDC (OpenID Connect) sign-in routes — mounted at /api/auth/oidc.
// Additive to the existing local username/password login in routes/auth.js
// (untouched by this file): local login is the permanent fallback, and
// every route here degrades to a clear, safe response when OIDC isn't
// configured rather than ever taking the rest of the panel down with it.
//
// This file owns provider config, the PKCE/state/nonce flow, and ID token
// validation (services/oidc.js). It deliberately does NOT own user or role
// resolution — once a token is validated, /callback hands the issuer and
// subject to authService.loginWithExternalIdentity(), which applies the
// find-or-refuse and role policy.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import authService from "../services/auth.js";
import { createLogger } from "../utils/logger.js";
import { sanitizeError, isMaskedSecret } from "../utils/sanitize.js";
import {
  getOidcSettings,
  getOidcEnvOverrides,
  setOidcSettings,
  isOidcConfigured,
  buildOidcAuthorizationRequest,
  handleOidcCallback,
  resetOidcConfigCache,
  testOidcDiscovery,
} from "../services/oidc.js";
import { getRefreshCookieOptions } from "../utils/refreshCookie.js";
import { requirePermission } from "../services/permissions.js";

const log = createLogger("OIDC");
const router = Router();

// Mirrors routes/auth.js's own loginLimiter (5/min) — same reasoning
// applies here: both routes below do real work (a redirect build, a full
// token exchange + DB lookup) that's worth protecting from abuse, same as
// the local login route already is. Separate instances (not one shared
// limiter) so a legitimate user's normal login→callback round trip doesn't
// spend a single shared budget twice per attempt.
function makeOidcLimiter() {
  return rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Please try again later." },
  });
}
const loginRateLimiter = makeOidcLimiter();
const callbackRateLimiter = makeOidcLimiter();

const FLOW_COOKIE_NAME = "oidcFlow";
const FLOW_COOKIE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes — enough for an IdP login + MFA, short enough to limit exposure.

// The state/nonce/PKCE cookie deliberately uses SameSite=Lax, not Strict:
// unlike the refresh-token cookie above (only ever sent by same-site XHR
// from the panel's own SPA), this one MUST be sent when the browser lands
// back on /api/auth/oidc/callback via a top-level cross-site GET redirect
// FROM the identity provider's domain — SameSite=Strict cookies are not
// sent on that navigation and the flow would break on every provider.
// Unsigned is fine: it carries no secret, only values the IdP is separately
// asked to echo back — any tampering just fails the state/nonce/PKCE
// comparison inside openid-client and the sign-in is refused, same as if
// the cookie were absent.
function getFlowCookieOptions(req) {
  const forceSecureCookies =
    process.env.HTTPS === "true" || process.env.FORCE_HSTS === "true";
  const requestIsSecure =
    req.secure || req.headers["x-forwarded-proto"] === "https";
  return {
    httpOnly: true,
    secure: forceSecureCookies || requestIsSecure,
    sameSite: "lax",
    path: "/api/auth/oidc",
    maxAge: FLOW_COOKIE_MAX_AGE_MS,
  };
}

// GET /api/auth/oidc/status — public, no secrets. Lets the login screen
// decide whether to offer an SSO option at all.
router.get("/status", async (_req, res) => {
  const settings = await getOidcSettings();
  res.json({
    configured: isOidcConfigured(settings),
    providerName: settings.providerName,
  });
});

// GET /api/auth/oidc/login — starts the flow.
router.get("/login", loginRateLimiter, async (req, res) => {
  const settings = await getOidcSettings();
  if (!isOidcConfigured(settings)) {
    return res.status(404).json({ error: "OIDC is not configured" });
  }

  try {
    const { authorizationUrl, state, nonce, codeVerifier } =
      await buildOidcAuthorizationRequest();

    res.cookie(
      FLOW_COOKIE_NAME,
      JSON.stringify({ state, nonce, codeVerifier }),
      getFlowCookieOptions(req),
    );
    res.redirect(authorizationUrl);
  } catch (error) {
    log.warn(`OIDC login start failed: ${error.message}`);
    res.status(502).json({
      error: sanitizeError(
        "Could not reach the identity provider. Try local sign-in, or contact your administrator.",
      ),
    });
  }
});

// GET /api/auth/oidc/callback — the redirect back from the IdP. This is a
// full-page browser navigation, not an XHR, so on both success and failure
// it redirects the browser rather than returning raw JSON — always back to
// the panel's own root, which already handles "there's a valid refresh
// cookie" as part of its existing auto-login bootstrap (see
// routes/auth.js's POST /refresh), so no client-side change is needed to
// pick up a session set here. Failures redirect with a short, generic
// reason code only — never a raw error message — for whichever future UI
// work wants to surface it.
router.get("/callback", callbackRateLimiter, async (req, res) => {
  const settings = await getOidcSettings();
  if (!isOidcConfigured(settings)) {
    return res.redirect("/?oidcError=not_configured");
  }

  const rawFlowCookie = req.cookies?.[FLOW_COOKIE_NAME];
  const { maxAge: _unused, ...clearFlowCookieOptions } = getFlowCookieOptions(req);
  res.clearCookie(FLOW_COOKIE_NAME, clearFlowCookieOptions);

  let flow;
  try {
    flow = rawFlowCookie ? JSON.parse(rawFlowCookie) : null;
  } catch {
    flow = null;
  }
  if (!flow) {
    log.warn("OIDC callback with no/invalid flow cookie (expired, or CSRF attempt)");
    return res.redirect("/?oidcError=expired_flow");
  }

  const currentUrl = new URL(settings.redirectUri);
  const queryIndex = req.url.indexOf("?");
  currentUrl.search = queryIndex === -1 ? "" : req.url.slice(queryIndex);

  let claims;
  try {
    claims = await handleOidcCallback(currentUrl, flow);
  } catch (error) {
    log.warn(`OIDC callback rejected: ${error.message}`);
    return res.redirect("/?oidcError=invalid_token");
  }

  // Token verification already happened in handleOidcCallback. This route
  // passes the validated identity to authService and does not auto-create an
  // account for an unlinked identity.
  let result;
  try {
    result = await authService.loginWithExternalIdentity(
      { issuer: claims.iss, subject: claims.sub, email: claims.email },
      true,
    );
  } catch (error) {
    log.error(`OIDC session issuance failed: ${error.message}`);
    return res.redirect("/?oidcError=session_failed");
  }

  // Never bootstrap an OIDC identity here. A fresh installation must use the
  // password setup flow's trust boundary; this branch only reports whether
  // setup is required or the identity is refused.
  if (!result.linked) {
    log.warn(
      `OIDC identity not linked to any account (sub=${claims.sub}, canBootstrapAdmin=${result.canBootstrapAdmin})`,
    );
    return res.redirect(
      result.canBootstrapAdmin ? "/?oidcError=setup_required" : "/?oidcError=refused",
    );
  }

  res.cookie("refreshToken", result.refreshToken, getRefreshCookieOptions(req));
  log.info(`OIDC sign-in: ${result.user.username} (sub=${claims.sub})`);
  res.redirect("/");
});

// ---------------------------------------------------------------------------
// Settings (Settings screen) — gated on panel.settings, the capability that
// already owns every other panel-wide setting. Not a new capability.
// ---------------------------------------------------------------------------

const MAX_SCOPE_LENGTH = 500;
const MAX_PROVIDER_NAME_LENGTH = 100;

function looksLikeUrl(value, { allowHttp }) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && allowHttp) return true;
    return false;
  } catch {
    return false;
  }
}

function publicSettingsShape(settings) {
  return {
    issuerUrl: settings.issuerUrl,
    clientId: settings.clientId,
    // Same category as the JWT secret: a GET says only whether it's
    // configured, never the value, masked or otherwise. Never echoed back.
    clientSecretConfigured: Boolean(settings.clientSecret),
    redirectUri: settings.redirectUri,
    scope: settings.scope,
    providerName: settings.providerName,
    allowInsecureHttp: settings.allowInsecureHttp,
    configured: isOidcConfigured(settings),
  };
}

// GET /api/auth/oidc/settings — the settings screen's own read.
router.get("/settings", requirePermission("panel.settings"), async (req, res) => {
  const settings = await getOidcSettings();
  res.json({
    ...publicSettingsShape(settings),
    // Which fields are currently pinned by an environment variable, so the
    // UI can show "set via environment variable" instead of accepting an
    // edit that env would silently win over anyway.
    envOverrides: getOidcEnvOverrides(),
    // Derived from THIS request's own origin, not guessed from other
    // settings -- guaranteed to match whatever the operator is actually
    // browsing the panel through right now (reverse proxy, port-forward,
    // custom domain, whatever), for pasting into the identity provider.
    suggestedRedirectUri: `${req.protocol}://${req.get("host")}/api/auth/oidc/callback`,
  });
});

// PUT /api/auth/oidc/settings — partial update: only fields present in the
// body are touched, same shape as PUT /api/servers/:id.
router.put("/settings", requirePermission("panel.settings"), async (req, res) => {
  try {
    const body = req.body || {};
    const current = await getOidcSettings();
    const updates = {};

    if (body.issuerUrl !== undefined) {
      const value = String(body.issuerUrl).trim();
      if (value) {
        const allowHttp =
          body.allowInsecureHttp !== undefined
            ? Boolean(body.allowInsecureHttp)
            : current.allowInsecureHttp;
        if (!looksLikeUrl(value, { allowHttp })) {
          return res.status(400).json({
            error: allowHttp
              ? "issuerUrl must be a valid URL"
              : "issuerUrl must be a valid https:// URL (enable allowInsecureHttp to permit http://)",
          });
        }
      }
      updates.issuerUrl = value;
    }

    if (body.clientId !== undefined) {
      updates.clientId = String(body.clientId).trim();
    }

    if (body.clientSecret !== undefined) {
      // A resubmitted masked placeholder means "leave it as-is" -- same
      // round-trip convention as every other secret field in this app.
      if (!isMaskedSecret(body.clientSecret)) {
        updates.clientSecret = String(body.clientSecret);
      }
    }

    if (body.redirectUri !== undefined) {
      const value = String(body.redirectUri).trim();
      if (value) {
        try {
          new URL(value);
        } catch {
          return res.status(400).json({ error: "redirectUri must be a valid URL" });
        }
      }
      updates.redirectUri = value;
    }

    if (body.scope !== undefined) {
      const value = String(body.scope).trim();
      if (value.length > MAX_SCOPE_LENGTH) {
        return res
          .status(400)
          .json({ error: `scope must be ${MAX_SCOPE_LENGTH} characters or fewer` });
      }
      updates.scope = value;
    }

    if (body.providerName !== undefined) {
      const value = String(body.providerName).trim();
      if (value.length > MAX_PROVIDER_NAME_LENGTH) {
        return res
          .status(400)
          .json({ error: `providerName must be ${MAX_PROVIDER_NAME_LENGTH} characters or fewer` });
      }
      updates.providerName = value;
    }

    if (body.allowInsecureHttp !== undefined) {
      updates.allowInsecureHttp = Boolean(body.allowInsecureHttp);
    }

    await setOidcSettings(updates);

    // THE TRAP: getOidcConfig() memoizes discovery process-wide and only a
    // FAILED discovery clears it. Without this line, a save reports
    // success and the panel keeps authenticating against the OLD provider
    // config until the process restarts -- the panel asserting something
    // false about itself on the exact screen built to fix a broken login.
    resetOidcConfigCache();

    const settings = await getOidcSettings();
    log.info(
      `OIDC settings updated (fields: ${Object.keys(updates).join(", ") || "none"})`,
    );
    res.json({ success: true, ...publicSettingsShape(settings) });
  } catch (error) {
    log.error(`Failed to update OIDC settings: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// POST /api/auth/oidc/test-connection — runs discovery only (no login round
// trip, nothing persisted, the live memoized config is untouched) against
// either the values in the body or, for any field left out, whatever is
// currently saved -- so the operator can test a partial edit (e.g. just a
// rotated client secret) without retyping everything, and test BEFORE
// committing a change that might be wrong.
router.post("/test-connection", requirePermission("panel.settings"), async (req, res) => {
  const body = req.body || {};
  const current = await getOidcSettings();

  const clientSecret =
    body.clientSecret !== undefined && !isMaskedSecret(body.clientSecret)
      ? String(body.clientSecret)
      : current.clientSecret;

  const result = await testOidcDiscovery({
    issuerUrl:
      body.issuerUrl !== undefined ? String(body.issuerUrl).trim() : current.issuerUrl,
    clientId:
      body.clientId !== undefined ? String(body.clientId).trim() : current.clientId,
    clientSecret,
    redirectUri:
      body.redirectUri !== undefined ? String(body.redirectUri).trim() : current.redirectUri,
    allowInsecureHttp:
      body.allowInsecureHttp !== undefined
        ? Boolean(body.allowInsecureHttp)
        : current.allowInsecureHttp,
  });

  res.json(result);
});

export default router;
