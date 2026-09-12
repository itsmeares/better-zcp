import { createStart } from '@tanstack/react-start'
import { authClientMiddleware } from './lib/authToken'

export const startInstance = createStart(() => ({
  functionMiddleware: [authClientMiddleware],
}))
