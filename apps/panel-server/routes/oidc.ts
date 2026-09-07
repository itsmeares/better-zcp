import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import authService from "../services/auth.js";
import { createLogger } from "../utils/logger.ts";
import { sanitizeError, isMaskedSecret } from "../utils/sanitize.ts";
import {
  getOidcSettings,
  getOidcEnvOverrides,
  setOidcSettings,
  isOidcConfigured,
  buildOidcAuthorizationRequest,
  handleOidcCallback,
  resetOidcConfigCache,
  testOidcDiscovery,
  type OidcSettings,
  type OidcSettingsUpdates,
} from "../services/oidc.ts";
import { getRefreshCookieOptions } from "../utils/refreshCookie.ts";
import { requirePermission } from "../services/permissions.ts";

const log = createLogger("OIDC");
const router = Router();

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
const FLOW_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

function getFlowCookieOptions(req: Request) {
  const forceSecureCookies =
    process.env.HTTPS === "true" || process.env.FORCE_HSTS === "true";
  const requestIsSecure =
    req.secure || req.headers["x-forwarded-proto"] === "https";
  return {
    httpOnly: true,
    secure: forceSecureCookies || requestIsSecure,
    sameSite: "lax" as const,
    path: "/api/auth/oidc",
    maxAge: FLOW_COOKIE_MAX_AGE_MS,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

router.get("/status", async (_req, res) => {
  const settings = await getOidcSettings();
  res.json({
    configured: isOidcConfigured(settings),
    providerName: settings.providerName,
  });
});

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
  } catch (error: unknown) {
    log.warn(`OIDC login start failed: ${errorMessage(error)}`);
    res.status(502).json({
      error: sanitizeError(
        "Could not reach the identity provider. Try local sign-in, or contact your administrator.",
      ),
    });
  }
});

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
  } catch (error: unknown) {
    log.warn(`OIDC callback rejected: ${errorMessage(error)}`);
    return res.redirect("/?oidcError=invalid_token");
  }

  let result;
  try {
    result = await authService.loginWithExternalIdentity(
      { issuer: claims.iss, subject: claims.sub, email: claims.email },
      true,
    );
  } catch (error: unknown) {
    log.error(`OIDC session issuance failed: ${errorMessage(error)}`);
    return res.redirect("/?oidcError=session_failed");
  }

  if (!result.linked) {
    log.warn(
      `OIDC identity not linked to any account (sub=${claims.sub}, canBootstrapAdmin=${result.canBootstrapAdmin})`,
    );
    return res.redirect(
      result.canBootstrapAdmin ? "/?oidcError=setup_required" : "/?oidcError=refused",
    );
  }

  res.cookie("refreshToken", result.refreshToken, getRefreshCookieOptions(req));
  log.info(`OIDC sign-in: ${result.user?.username ?? "unknown"} (sub=${claims.sub})`);
  res.redirect("/");
});


const MAX_SCOPE_LENGTH = 500;
const MAX_PROVIDER_NAME_LENGTH = 100;

function looksLikeUrl(
  value: unknown,
  { allowHttp }: { allowHttp: boolean },
): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && allowHttp) return true;
    return false;
  } catch {
    return false;
  }
}

function publicSettingsShape(settings: OidcSettings) {
  return {
    issuerUrl: settings.issuerUrl,
    clientId: settings.clientId,
    clientSecretConfigured: Boolean(settings.clientSecret),
    redirectUri: settings.redirectUri,
    scope: settings.scope,
    providerName: settings.providerName,
    allowInsecureHttp: settings.allowInsecureHttp,
    configured: isOidcConfigured(settings),
  };
}

router.get("/settings", requirePermission("panel.settings"), async (req, res) => {
  const settings = await getOidcSettings();
  res.json({
    ...publicSettingsShape(settings),
    envOverrides: getOidcEnvOverrides(),
    suggestedRedirectUri: `${req.protocol}://${req.get("host")}/api/auth/oidc/callback`,
  });
});

router.put("/settings", requirePermission("panel.settings"), async (req, res) => {
  try {
    const body = req.body || {};
    const current = await getOidcSettings();
    const updates: OidcSettingsUpdates = {};

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

    resetOidcConfigCache();

    const settings = await getOidcSettings();
    log.info(
      `OIDC settings updated (fields: ${Object.keys(updates).join(", ") || "none"})`,
    );
    res.json({ success: true, ...publicSettingsShape(settings) });
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to update OIDC settings: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

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
