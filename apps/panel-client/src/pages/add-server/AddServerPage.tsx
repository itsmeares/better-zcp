import { useState } from 'react'
import { ChevronRight, Download, FolderCog, Plug } from 'lucide-react'
import { formatUptime } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConnectFlow } from './ConnectFlow'
import { clearInstallInFlightMarker, InstallFlow, readInstallInFlightMarker, type InstallInFlightMarker } from './InstallFlow'
import { SetupFilesFlow } from './SetupFilesFlow'

type Mode = 'choose' | 'install' | 'files' | 'connect'

const CHOICES = [
  {
    mode: 'install',
    icon: Download,
    title: 'Install a new server',
    description: 'Download the dedicated server with SteamCMD (about 3 GB), choose a game version, and generate its config and start script.',
  },
  {
    mode: 'files',
    icon: FolderCog,
    title: 'Set up downloaded files',
    description: "You already have the server files, but they've never been set up. The panel writes the config and start script.",
  },
  {
    mode: 'connect',
    icon: Plug,
    title: 'Connect an existing server',
    description: 'The server already runs on this machine or in Docker. The panel finds its config and starts managing it.',
  },
] as const

const TITLES: Record<Mode, string> = {
  choose: 'Add a server',
  install: 'Install a new server',
  files: 'Set up downloaded files',
  connect: 'Connect an existing server',
}

export default function AddServerPage() {
  const [mode, setMode] = useState<Mode>('choose')
  const [resume, setResume] = useState<InstallInFlightMarker | null>(readInstallInFlightMarker)
  const [resuming, setResuming] = useState(false)
  const back = () => {
    setMode('choose')
    setResuming(false)
  }

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6">
      <PageHeader title={TITLES[mode]} description={mode === 'choose' ? 'Pick how you want to bring a Project Zomboid server into the panel.' : undefined} />

      {mode === 'choose' && (
        <>
          {resume && (
            <Alert variant="warning">
              <AlertTitle>An install may still be running</AlertTitle>
              <AlertDescription>
                An install to {resume.installPath} started {formatUptime(Math.max(0, Math.floor((Date.now() - resume.startedAt) / 1000)))} ago, and the page was closed before it
                finished. It may still be downloading.
              </AlertDescription>
              <AlertAction>
                <Button
                  size="xs"
                  onClick={() => {
                    setResuming(true)
                    setMode('install')
                  }}
                >
                  Continue
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    clearInstallInFlightMarker()
                    setResume(null)
                  }}
                >
                  Dismiss
                </Button>
              </AlertAction>
            </Alert>
          )}
          <ul className="grid gap-3">
            {CHOICES.map((choice) => (
              <li key={choice.mode}>
                <button
                  type="button"
                  onClick={() => setMode(choice.mode)}
                  className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-4 rounded-2xl border bg-card p-5 text-start shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="grid size-10 place-items-center rounded-xl bg-muted">
                    <choice.icon className="size-5" />
                  </span>
                  <span className="grid gap-1">
                    <span className="font-medium">{choice.title}</span>
                    <span className="text-sm text-muted-foreground">{choice.description}</span>
                  </span>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">Never set up a Project Zomboid server before? Install a new server; it downloads everything you need.</p>
        </>
      )}

      {mode === 'install' && <InstallFlow onExit={back} resume={resuming ? resume : null} />}
      {mode === 'files' && <SetupFilesFlow onExit={back} />}
      {mode === 'connect' && <ConnectFlow onExit={back} />}
    </div>
  )
}
