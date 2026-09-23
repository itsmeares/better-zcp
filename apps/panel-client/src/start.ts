import { createStart } from '@tanstack/react-start'
import { authClientMiddleware } from './lib/authClientMiddleware'

export const startInstance = createStart(() => ({
  functionMiddleware: [authClientMiddleware],
}))
