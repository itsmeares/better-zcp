import { createFileRoute } from '@tanstack/react-router'
import {
  buildPanelInfo,
  resolvePanelLocalIp,
  resolvePanelInfoPort,
} from '../../../../panel-server/utils/panelInfo.ts'

export const Route = createFileRoute('/api/panel-info')({
  server: {
    handlers: {
      GET: async () => {
        const { getSetting } = await import('../../../../panel-server/database/init.ts')
        const savedPort = await getSetting('panelPort')
        const port = resolvePanelInfoPort(savedPort)
        const localIp = await resolvePanelLocalIp(getSetting)
        return Response.json(buildPanelInfo(localIp, port))
      },
    },
  },
})
