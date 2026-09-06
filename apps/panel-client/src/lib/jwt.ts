// Reads the `exp` claim out of a JWT WITHOUT verifying its signature -- this
// is only ever used to decide whether OUR OWN cached access token is worth
// sending on a socket (re)connect, or whether it's worth calling
// /api/auth/refresh first. The server remains the only real authority on
// whether a token is actually valid; this check never gates access to
// anything by itself, it only decides whether to bother refreshing before
// asking. No JWT library: reading one claim out of a token we already hold
// doesn't need one.
export function isTokenExpiredOrNearExpiry(token: string, bufferMs = 60_000): boolean {
  const exp = decodeJwtExpiry(token)
  if (exp === null) return true // unreadable/malformed -- treat as needing a refresh
  return exp * 1000 - bufferMs <= Date.now()
}

function decodeJwtExpiry(token: string): number | null {
  try {
    const payloadSegment = token.split('.')[1]
    if (!payloadSegment) return null
    const base64 = payloadSegment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const json = atob(padded)
    const payload = JSON.parse(json) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}
