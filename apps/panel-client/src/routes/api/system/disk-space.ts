import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/system/disk-space')({
  server: {
    handlers: {
      GET: async () => {
        const { getPanelRuntime } =
          await import('../../../../../panel-server/utils/panelRuntime.ts')
        const { buildDiskSpace } =
          await import('../../../../../panel-server/utils/systemInfo.ts')
        return Response.json(await buildDiskSpace(getPanelRuntime().diskMonitor))
      },
    },
  },
})
