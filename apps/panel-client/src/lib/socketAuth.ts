import { tryRefreshToken } from './api'
import { isTokenExpiredOrNearExpiry } from './jwt'

/**
 * Builds a socket.io `auth` provider function. Passing `auth` as a
 * FUNCTION (not a plain object) is what lets this refresh the access
 * token first when it's stale, instead of racing a synchronous read
 * against however long a refresh call takes -- socket.io calls the
 * returned function itself, with a callback, immediately before sending
 * the CONNECT packet on EVERY connection attempt (the initial connect,
 * every automatic reconnect, and any manual .connect() call), so there is
 * exactly one place this logic lives, not one copy per trigger.
 *
 * Reads OUR OWN token purely to decide whether calling /api/auth/refresh
 * first is worth it; the server remains the only real authority on
 * whether the token it's handed is actually valid.
 */
export function createSocketAuthProvider(getToken: () => string | null) {
  return (callback: (data: Record<string, string>) => void) => {
    void (async () => {
      let token = getToken()
      if (token && isTokenExpiredOrNearExpiry(token)) {
        await tryRefreshToken()
        token = getToken()
      }
      callback(token ? { token } : {})
    })()
  }
}
