import { tryRefreshToken } from './api'
import { isTokenExpiredOrNearExpiry } from './jwt'

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
