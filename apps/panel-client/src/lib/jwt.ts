export function isTokenExpiredOrNearExpiry(token: string, bufferMs = 60_000): boolean {
  const exp = decodeJwtExpiry(token)
  if (exp === null) return true
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
