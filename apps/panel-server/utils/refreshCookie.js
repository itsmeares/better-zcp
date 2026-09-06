
const forceSecureCookies =
  process.env.HTTPS === "true" || process.env.FORCE_HSTS === "true";

export function getRefreshCookieOptions(req, includeMaxAge = true) {
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
