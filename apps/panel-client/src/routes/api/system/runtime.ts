import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/system/runtime')({
  server: {
    handlers: {
      GET: async () => {
        const { buildRuntimeInfo } =
          await import('../../../../../panel-server/utils/runtimeInfo.ts')
        return Response.json(buildRuntimeInfo())
      },
    },
  },
})
