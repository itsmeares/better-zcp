import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { configApi, serverApi } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { SettingsCard, SettingsRow } from '@/components/settings-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { toastManager } from '@/components/ui/toast'
import type { AppSettingsState } from './useAppSettings'

interface CorsDiagnostics {
  effectiveAllowedOrigins: string[]
  blocked: Array<{ id: number; origin: string; source: string; blockedAt: string }>
  blockedCount: number
  lastLoadedAt: string | null
}

const MAX_ORIGINS = 100
const MAX_ORIGIN_LENGTH = 256

export function validateCorsOrigins(raw: string): string | null {
  const origins = raw.split(/[\n,;]+/).map((origin) => origin.trim()).filter(Boolean)
  if (origins.length > MAX_ORIGINS) return `Too many origins. The limit is ${MAX_ORIGINS}.`
  for (const origin of origins) {
    if (origin.length > MAX_ORIGIN_LENGTH) return `Origin too long (${origin.length} characters). The limit is ${MAX_ORIGIN_LENGTH}.`
    try {
      if (!['http:', 'https:'].includes(new URL(origin).protocol)) return `Only http and https origins are allowed: ${origin}`
    } catch {
      return `Not a valid origin: ${origin}`
    }
  }
  return null
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'Never'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function RemoteAccessSection({ state }: { state: AppSettingsState }) {
  const { settings, update, saving } = state
  const [diagnostics, setDiagnostics] = useState<CorsDiagnostics | null>(null)
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false)
  const [updatingCors, setUpdatingCors] = useState(false)
  const [interfaces, setInterfaces] = useState<{ name: string; address: string }[]>([])
  const [confirmLanOff, setConfirmLanOff] = useState(false)
  const originError = validateCorsOrigins(settings.corsAllowedOrigins)

  const fetchDiagnostics = useCallback(async () => {
    setLoadingDiagnostics(true)
    try {
      setDiagnostics((await configApi.getCorsDiagnostics()).diagnostics)
    } catch (error) {
      reportClientError('Failed to fetch CORS diagnostics.', error)
      toastManager.add({ title: "Couldn't refresh CORS diagnostics", description: 'The numbers below are stale.', type: 'error' })
    } finally {
      setLoadingDiagnostics(false)
    }
  }, [])

  useEffect(() => {
    void fetchDiagnostics()
    serverApi
      .getNetworkInterfaces()
      .then((data) => setInterfaces(data.interfaces || []))
      .catch(() => setInterfaces([]))
  }, [fetchDiagnostics])

  const runCorsAction = async (action: () => Promise<{ diagnostics: CorsDiagnostics }>, success: string, failure: string) => {
    setUpdatingCors(true)
    try {
      setDiagnostics((await action()).diagnostics)
      toastManager.add({ title: success, type: 'success' })
    } catch (error) {
      toastManager.add({ title: failure, description: getUserErrorMessage(error, failure), type: 'error' })
    } finally {
      setUpdatingCors(false)
    }
  }

  const onLanToggle = (value: boolean) => {
    if (!value && !settings.corsAllowAll && !settings.corsAllowedOrigins.trim()) {
      setConfirmLanOff(true)
      return
    }
    update('corsAllowPrivateNetworks', value)
  }

  const lanItems = [{ value: 'auto', label: 'Detect automatically' }, ...interfaces.map((iface) => ({ value: iface.address, label: `${iface.name} · ${iface.address}` }))]

  return (
    <div className="grid gap-4">
      <SettingsCard
        title="Who can reach the panel"
        description="Browsers block pages from talking to an address they weren't loaded from. If you only open the panel on this machine, the defaults are fine."
      >
        <SettingsRow label="Allow private and LAN addresses" htmlFor="cors-lan" description="localhost and private network ranges can always connect.">
          <Switch id="cors-lan" checked={settings.corsAllowPrivateNetworks} onCheckedChange={onLanToggle} />
        </SettingsRow>
        <SettingsRow
          label="Extra allowed addresses"
          htmlFor="cors-origins"
          stacked
          description="One per line, with http:// or https:// and the port if needed. Add the address you use when it's a domain name, a reverse proxy or a second network interface."
        >
          <div className="grid w-full gap-1.5">
            <Textarea
              id="cors-origins"
              className="font-mono"
              rows={4}
              value={settings.corsAllowedOrigins}
              onChange={(e) => update('corsAllowedOrigins', e.target.value)}
              placeholder={'http://123.45.67.89:3001\nhttps://panel.example.com'}
              aria-invalid={Boolean(originError)}
            />
            {originError && <p className="text-sm text-destructive-foreground">{originError}</p>}
          </div>
        </SettingsRow>
        <SettingsRow label="Allow every address" htmlFor="cors-all" description="Turns off origin checks. Only for short troubleshooting sessions.">
          <Switch id="cors-all" checked={settings.corsAllowAll} onCheckedChange={(value) => update('corsAllowAll', value)} />
        </SettingsRow>
        {settings.corsAllowAll && (
          <div className="pb-4">
            <Alert variant="warning">
              <AlertTriangle />
              <AlertTitle>Origin protection is off</AlertTitle>
              <AlertDescription>Any website can send requests to this panel from your browser while this is on.</AlertDescription>
            </Alert>
          </div>
        )}
        <SettingsRow label="Log blocked requests" htmlFor="cors-debug" description="Record blocked connection attempts for troubleshooting.">
          <Switch id="cors-debug" checked={settings.corsDebug} onCheckedChange={(value) => update('corsDebug', value)} />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="Blocked requests"
        description="Rules reload from saved settings. Save first, then reload."
        action={
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={updatingCors || saving || Boolean(originError)}
              onClick={() => void runCorsAction(configApi.reloadCorsDiagnostics, 'CORS rules reloaded', "Couldn't reload CORS rules")}
            >
              {updatingCors ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Reload rules
            </Button>
            <Button size="sm" variant="ghost" disabled={loadingDiagnostics || updatingCors} onClick={() => void fetchDiagnostics()}>
              Refresh
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={updatingCors || !diagnostics?.blockedCount}
              onClick={() => void runCorsAction(configApi.clearCorsBlockedOrigins, 'Blocked log cleared', "Couldn't clear the log")}
            >
              <Trash2 />
              Clear log
            </Button>
          </div>
        }
      >
        <dl className="grid grid-cols-3 gap-4 py-4 text-sm">
          <div className="grid gap-0.5">
            <dt className="text-muted-foreground">Blocked</dt>
            <dd className="font-medium tabular-nums">{diagnostics?.blockedCount ?? 0}</dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-muted-foreground">Allowed addresses</dt>
            <dd className="font-medium tabular-nums">{diagnostics?.effectiveAllowedOrigins.length ?? 0}</dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-muted-foreground">Last reload</dt>
            <dd className="font-medium">{formatTimestamp(diagnostics?.lastLoadedAt ?? null)}</dd>
          </div>
        </dl>
        {!!diagnostics?.blocked.length && (
          <ul className="mb-4 max-h-56 divide-y overflow-y-auto rounded-lg border text-sm">
            {diagnostics.blocked.slice(0, 12).map((entry) => (
              <li key={entry.id} className="grid gap-0.5 px-3 py-2">
                <span className="break-all font-mono">{entry.origin}</span>
                <span className="text-muted-foreground">
                  {entry.source.toUpperCase()} · {formatTimestamp(entry.blockedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>

      <SettingsCard title="Addresses shown on Overview">
        <SettingsRow
          label="LAN address"
          description="Which network interface's address Overview shows. Useful when this host has more than one, such as Tailscale and ZeroTier."
        >
          <Select items={lanItems} value={settings.lanIpAddress || 'auto'} onValueChange={(value) => update('lanIpAddress', value === 'auto' ? '' : String(value))}>
            <SelectTrigger className="w-64" aria-label="LAN address">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {lanItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Show the public IP address"
          htmlFor="public-ip"
          description="Looks up this machine's public IP through api.ipify.org, at most once per restart. Off by default to avoid an outside call on LAN-only setups."
        >
          <Switch id="public-ip" checked={settings.enablePublicIpLookup} onCheckedChange={(value) => update('enablePublicIpLookup', value)} />
        </SettingsRow>
      </SettingsCard>

      <AlertDialog open={confirmLanOff} onOpenChange={setConfirmLanOff}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Lock yourself out of the panel?</AlertDialogTitle>
            <AlertDialogDescription>
              With LAN addresses off, no extra addresses listed and "Allow every address" off, the next rules reload blocks every browser,
              including this one. To recover you would have to restart the panel with the <code className="font-mono">CORS_ORIGINS</code>{' '}
              environment variable set, for example <code className="font-mono">CORS_ORIGINS=https://panel.example.com</code>. Add at least one
              address above first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep LAN access on</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                update('corsAllowPrivateNetworks', false)
                setConfirmLanOff(false)
              }}
            >
              Turn it off anyway
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  )
}
