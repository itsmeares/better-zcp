import { createMiddleware } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'

const compatibilityMiddleware = createMiddleware({ type: 'request' }).server(
  async ({ request }) => {
    const { handleStartApiCompatibilityRequest } =
      await import('../../lib/startApiCompatibility')
    return handleStartApiCompatibilityRequest(request)
  },
)

export const Route = createFileRoute('/api/$')({
  server: {
    middleware: [compatibilityMiddleware],
  },
})
