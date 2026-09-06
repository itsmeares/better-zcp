/**
 * Shared cookie policy for the panel's refresh-token cookie.
 *
 * Both routes import this definition so the security-relevant cookie policy
 * cannot drift between password and OIDC flows.
 */

// Force all refresh cookies to be Secure when the operator has explicitly
// declared this deployment is HTTPS-only (VPS behind TLS termination).
const forceSecureCookies =
  process.env.HTTPS === "true" || process.env.FORCE_HSTS === "true";

export function getRefreshCookieOptions(req, includeMaxAge = true) {
  // Decide `secure` from THIS request's own protocol, not a shared global
  // latch. The latch previously flipped on permanently the first time ANY
  // client was seen over HTTPS, after which every plain-HTTP LAN client
  // silently stopped receiving the refresh cookie (browsers drop `Secure`
  // cookies set over HTTP) — with no error to explain why. In a mixed
  // LAN(HTTP)+remote(HTTPS) deployment each request now gets the right flag
  // for its own connection.
  const requestIsSecure =
    req.secure || req.headers["x-forwarded-proto"] === "https";
  return {
    httpOnly: true,
    secure: forceSecureCookies || requestIsSecure,
    sameSite: "strict",
    path: "/api/auth",
    ...(includeMaxAge ? { maxAge: 30 * 24 * 60 * 60 * 1000 } : {}),
  };
}
