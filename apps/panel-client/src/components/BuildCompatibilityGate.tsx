import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
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
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-xl rounded-lg border border-destructive/40 bg-card p-6 shadow-lg">
          <p className="text-sm font-semibold uppercase tracking-wide text-destructive">Update recovery required</p>
          <h1 className="mt-2 text-2xl font-bold">Frontend and backend versions do not match</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            The panel stopped before authentication and live connections were initialized. Restart with Start.bat to let the updater finish or roll back the incomplete bundle.
          </p>
          <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt>Frontend</dt><dd className="font-mono">{frontend.panelVersion} ({frontend.buildSha.slice(0, 12)})</dd>
            <dt>Backend</dt><dd className="font-mono">{backendVersion} ({String(backend.buildSha || 'unknown').slice(0, 12)})</dd>
          </dl>
          <button className="mt-6 rounded-md bg-primary px-4 py-2 text-primary-foreground" onClick={() => window.location.reload()}>
            Check again
          </button>
        </section>
      </main>
    )
  }
  return <>{children}</>
}
