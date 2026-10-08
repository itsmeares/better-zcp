import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'
import {
  assessBuildCompatibility,
  compiledBuildMetadata,
} from '../lib/buildCompatibility'
import { isDemoMode } from '../lib/demo'
import { panelHealthQueryOptions } from '../lib/panelHealth'

export function BuildCompatibilityGate({ children }: { children: ReactNode }) {
  const demoMode = isDemoMode()
  const { data: backend, isPending, isError } = useQuery({
    ...panelHealthQueryOptions(),
    enabled: !demoMode,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  if (!demoMode && isPending) {
    return <main className="min-h-screen bg-background" aria-label="Checking panel compatibility" />
  }
  if (demoMode || isError || !backend) return <>{children}</>

  const result = assessBuildCompatibility(compiledBuildMetadata(), backend)
  if (!result.compatible) {
    const frontend = compiledBuildMetadata()
    const backendVersion = backend.panelVersion || backend.version || 'unknown'
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-4 text-foreground">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-5 text-destructive" />
              The panel's two halves don't match
            </CardTitle>
            <CardDescription>
              The web page and the panel service come from different versions, usually because an update stopped partway. The panel paused before sign-in so nothing runs on a mixed install. Restart the panel so the updater can finish or roll back.
            </CardDescription>
          </CardHeader>
          <CardPanel className="grid gap-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Web page</dt>
              <dd className="font-mono text-xs leading-5">
                {frontend.panelVersion} ({frontend.buildSha.slice(0, 12)})
              </dd>
              <dt className="text-muted-foreground">Panel service</dt>
              <dd className="font-mono text-xs leading-5">
                {backendVersion} ({String(backend.buildSha || 'unknown').slice(0, 12)})
              </dd>
            </dl>
            <Button className="justify-self-start" onClick={() => window.location.reload()}>
              Check again
            </Button>
          </CardPanel>
        </Card>
      </main>
    )
  }
  return <>{children}</>
}
