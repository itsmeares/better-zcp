import { createMiddleware } from '@tanstack/react-start'

let accessToken: string | null = null

export const authClientMiddleware = createMiddleware({ type: 'function' }).client(
  ({ next }) => {
    const token = getAccessToken()
    return next(
      token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    )
  },
)

export function getAccessToken(): string | null {
  return accessToken
}

export function setAccessToken(token: string | null) {
  accessToken = token
}

export function clearAccessToken() {
  accessToken = null
}
