import { createFileRoute } from '@tanstack/react-router'
import { compiledBuildMetadata } from '../../lib/buildCompatibility'
import { buildPanelHealthPayload } from '../../../../panel-server/utils/panelHealth.ts'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () => Response.json(buildPanelHealthPayload(compiledBuildMetadata())),
    },
  },
})
