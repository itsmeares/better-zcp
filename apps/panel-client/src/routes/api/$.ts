import { createMiddleware } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { handleStartApiCompatibilityRequest } from '../../lib/startApiCompatibility'

const compatibilityMiddleware = createMiddleware({ type: 'request' }).server(
  ({ request }) => handleStartApiCompatibilityRequest(request),
)

export const Route = createFileRoute('/api/$')({
  server: {
    middleware: [compatibilityMiddleware],
  },
})
