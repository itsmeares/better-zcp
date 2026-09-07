const forceSecureCookies =
  process.env.HTTPS === "true" || process.env.FORCE_HSTS === "true";

interface RefreshCookieRequest {
  secure?: boolean;
  headers?: Record<string, string | string[] | undefined>;
}

export interface RefreshCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "strict";
  path: "/api/auth";
  maxAge?: number;
}

export function getRefreshCookieOptions(
  req: RefreshCookieRequest,
  includeMaxAge = true,
): RefreshCookieOptions {
  const requestIsSecure =
    req.secure || req.headers?.["x-forwarded-proto"] === "https";
  return {
    httpOnly: true,
    secure: forceSecureCookies || Boolean(requestIsSecure),
    sameSite: "strict",
    path: "/api/auth",
    ...(includeMaxAge ? { maxAge: 30 * 24 * 60 * 60 * 1000 } : {}),
  };
}
