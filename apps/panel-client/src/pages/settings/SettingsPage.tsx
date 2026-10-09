import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { usePageShortcut } from '@/hooks/useKeyboardShortcuts'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'
import { PageLoading } from '@/components/PageLoading'
import { SaveBar } from '@/components/settings-layout'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toastManager } from '@/components/ui/toast'
import { AboutSection } from './AboutSection'
import { DataPathsSection } from './DataPathsSection'
import { GeneralSection, isValidPort } from './GeneralSection'
import { RemoteAccessSection, validateCorsOrigins } from './RemoteAccessSection'
import { SecuritySection } from './SecuritySection'
import { UpdatesSection } from './UpdatesSection'
import { useAppSettings } from './useAppSettings'

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'updates', label: 'Updates' },
  { id: 'access', label: 'Remote access' },
  { id: 'security', label: 'Security' },
  { id: 'paths', label: 'Data folders' },
  { id: 'about', label: 'About' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

// Tabs that existed before 3.0. Server-specific ones now live elsewhere.
const MOVED_TABS: Record<string, { to: '/mods' | '/backups' } | { tab: SectionId }> = {
  panel: { tab: 'general' },
  connection: { tab: 'general' },
  rcon: { tab: 'general' },
  'game-integration': { tab: 'general' },
  mods: { to: '/mods' },
  'api-keys': { to: '/mods' },
  backups: { to: '/backups' },
}

function isSection(value: string | null): value is SectionId {
  return SECTIONS.some((section) => section.id === value)
}

export default function SettingsPage() {
  const state = useAppSettings()
  const { isDirty, saving, loading, loadError, saved, settings } = state
  const navigate = useNavigate()
  const { searchStr } = useLocation()
  const requested = new URLSearchParams(searchStr).get('tab')
  const [section, setSection] = useState<SectionId>(isSection(requested) ? requested : 'general')

  useEffect(() => {
    if (isSection(requested)) {
      setSection(requested)
      return
    }
    const moved = requested ? MOVED_TABS[requested] : undefined
    if (moved && 'to' in moved) void navigate({ to: moved.to, replace: true })
    else if (moved) void navigate({ to: '/settings', search: { tab: moved.tab }, replace: true })
  }, [requested, navigate])

  useEffect(() => {
    if (!isDirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isDirty])

  const corsError = validateCorsOrigins(settings.corsAllowedOrigins)

  const save = async () => {
    if (!isValidPort(Number(settings.panelPort))) {
      toastManager.add({ title: 'Check the panel port', description: 'Use a whole number from 1 to 65535.', type: 'error' })
      return
    }
    if (corsError) {
      toastManager.add({ title: 'Check the allowed addresses', description: corsError, type: 'error' })
      return
    }
    try {
      await state.save()
      toastManager.add({ title: 'Settings saved', type: 'success' })
    } catch (error) {
      toastManager.add({ title: "Couldn't save settings", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    }
  }

  usePageShortcut(
    's',
    () => {
      if (isDirty && !saving) void save()
    },
    { ctrl: true },
  )

  const selectSection = (id: SectionId) => {
    setSection(id)
    void navigate({ to: '/settings', search: { tab: id }, replace: true })
  }

  if (loading && !saved) return <PageLoading />

  if (loadError && !saved) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Settings" />
        <Alert variant="error">
          <AlertTriangle />
          <AlertTitle>Couldn't load settings</AlertTitle>
          <AlertDescription>{loadError} Nothing is editable until they load, so placeholders can't overwrite your real values.</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => void state.reload()} disabled={loading}>
              <RefreshCw className={cn(loading && 'animate-spin')} />
              Retry
            </Button>
          </AlertAction>
        </Alert>
      </div>
    )
  }

  return (
    <div className="grid gap-6 pb-20">
      <PageHeader title="Settings" description="Options for the panel itself. Each server has its own settings page." />

      <div className="grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:items-start">
        <nav aria-label="Settings sections" className="max-lg:hidden lg:sticky lg:top-20">
          <ul className="grid gap-0.5">
            {SECTIONS.map((item) => (
              <li key={item.id}>
                <Button
                  variant="ghost"
                  className={cn('w-full justify-start font-normal text-muted-foreground', section === item.id && 'bg-accent font-medium text-foreground')}
                  aria-current={section === item.id ? 'page' : undefined}
                  onClick={() => selectSection(item.id)}
                >
                  {item.label}
                </Button>
              </li>
            ))}
          </ul>
        </nav>
        <Select items={SECTIONS.map((item) => ({ value: item.id, label: item.label }))} value={section} onValueChange={(value) => selectSection(value as SectionId)}>
          <SelectTrigger className="lg:hidden" aria-label="Settings section">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {SECTIONS.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>

        <div className="min-w-0">
          {section === 'general' && <GeneralSection state={state} />}
          {section === 'updates' && <UpdatesSection state={state} />}
          {section === 'access' && <RemoteAccessSection state={state} />}
          {section === 'security' && <SecuritySection />}
          {section === 'paths' && <DataPathsSection />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>

      {isDirty && (
        <SaveBar
          message={state.changed.length === 1 ? '1 unsaved change' : `${state.changed.length} unsaved changes`}
          saving={saving}
          saveDisabled={Boolean(corsError)}
          onSave={() => void save()}
          onDiscard={state.discard}
        />
      )}
    </div>
  )
}
