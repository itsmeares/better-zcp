import { createMiddleware } from '@tanstack/react-start'
import { getAccessToken } from './authToken'

export const authClientMiddleware = createMiddleware({ type: 'function' }).client(
  ({ next }) => {
    const token = getAccessToken()
    return next(token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
  },
)
