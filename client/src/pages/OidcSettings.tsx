import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, ShieldAlert, Loader2, Copy, Check, CheckCircle2, XCircle } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardDescription, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { HelpTip } from '@/components/HelpTip'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { copyText } from '@/lib/utils'
import {
  oidcSettingsApi,
  ApiError,
  type OidcSettingsFields,
  type OidcSettingsWithEnv,
  type OidcSettingsUpdate,
  type OidcDiscoveredMetadata,
} from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'

// Prefills the issuer URL SHAPE and recommended scope for a known provider
// -- not a locked-in choice. The operator still has to substitute their own
// values (tenant ID, realm name, app slug, ...) for anything in angle
// brackets, and can freely edit the result same as the free-form path.
// issuerTemplate/scope are technical values (like fields.issuerUrlPlaceholder
// below), not translated content -- only the picker's own labels are.
interface ProviderPreset {
  id: string
  issuerTemplate: string
  scope: string
}
const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'google', issuerTemplate: 'https://accounts.google.com', scope: 'openid email profile' },
  {
    id: 'authentik',
    issuerTemplate: 'https://<authentik-domain>/application/o/<app-slug>/',
    scope: 'openid email profile',
  },
  {
    id: 'keycloak',
    issuerTemplate: 'https://<keycloak-domain>/realms/<realm-name>',
    scope: 'openid email profile',
  },
  {
    id: 'azuread',
    issuerTemplate: 'https://login.microsoftonline.com/<tenant-id>/v2.0',
    scope: 'openid email profile',
  },
  { id: 'okta', issuerTemplate: 'https://<okta-domain>/oauth2/default', scope: 'openid email profile' },
  { id: 'auth0', issuerTemplate: 'https://<your-domain>.auth0.com/', scope: 'openid email profile' },
]
const CUSTOM_PRESET_ID = 'custom'

// Matches server/utils/sanitize.js's isMaskedSecret() -- prefilling the
// field with exactly this sentinel when a secret is already stored, and
// submitting it back unchanged, is how the server knows "leave it alone"
// (GET never returns the real value, not even masked, so there is nothing
// else to prefill with).
const MASKED_SECRET_SENTINEL = '••••••••'

const FIELD_KEYS = (['issuerUrl', 'clientId', 'redirectUri', 'scope', 'providerName'] as const) satisfies readonly (keyof OidcSettingsFields)[]
type FieldKey = (typeof FIELD_KEYS)[number]

// Keep the form-field list aligned with the API type. The assertion catches
// both missing fields and stale keys at compile time.
type UncoveredOidcSettingsField = Exclude<keyof OidcSettingsFields, FieldKey | 'allowInsecureHttp'>
const _assertFieldKeysCoversOidcSettingsFields: UncoveredOidcSettingsField extends never
  ? true
  : { MISSING_FROM_FIELD_KEYS: UncoveredOidcSettingsField } = true
void _assertFieldKeysCoversOidcSettingsFields

// `embedded`: rendered inside a Settings tab panel instead of as its own
// route -- see the matching note on Users.tsx.
export default function OidcSettings({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation('oidcSettings')
  const { toast } = useToast()

  const [settings, setSettings] = useState<OidcSettingsWithEnv | null>(null)
  const [loading, setLoading] = useState(true)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [form, setForm] = useState<Record<FieldKey, string>>({
    issuerUrl: '',
    clientId: '',
    redirectUri: '',
    scope: '',
    providerName: '',
  })
  const [clientSecret, setClientSecret] = useState('')
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false)

  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [selectedPreset, setSelectedPreset] = useState<string>(CUSTOM_PRESET_ID)
  const [discoveryResult, setDiscoveryResult] = useState<OidcDiscoveredMetadata | null>(null)

  const applySettings = (data: OidcSettingsWithEnv) => {
    setSettings(data)
    setForm({
      issuerUrl: data.issuerUrl,
      clientId: data.clientId,
      redirectUri: data.redirectUri,
      scope: data.scope,
      providerName: data.providerName,
    })
    setClientSecret(data.clientSecretConfigured ? MASKED_SECRET_SENTINEL : '')
    setAllowInsecureHttp(data.allowInsecureHttp)
  }

  const fetchSettings = useCallback(async () => {
    setLoading(true)
    setPermissionDenied(false)
    setLoadError(null)
    try {
      const data = await oidcSettingsApi.get()
      applySettings(data)
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setPermissionDenied(true)
      } else {
        setLoadError(getUserErrorMessage(error, t('toasts.unknownError')))
      }
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  // Only the fields that actually changed from what GET returned -- PUT is a
  // partial update, same convention as PUT /api/servers/:id.
  function buildUpdatePayload(): OidcSettingsUpdate {
    if (!settings) return {}
    const updates: OidcSettingsUpdate = {}
    for (const key of FIELD_KEYS) {
      if (form[key] !== settings[key]) updates[key] = form[key]
    }
    if (allowInsecureHttp !== settings.allowInsecureHttp) {
      updates.allowInsecureHttp = allowInsecureHttp
    }
    if (clientSecret !== MASKED_SECRET_SENTINEL) {
      updates.clientSecret = clientSecret
    }
    return updates
  }

  async function handleSave() {
    setSaving(true)
    setFormError(null)
    setDiscoveryResult(null)
    try {
      const updates = buildUpdatePayload()
      const result = await oidcSettingsApi.update(updates)
      await fetchSettings()
      toast({
        title: t('toasts.settingsSavedTitle'),
        description: t('toasts.settingsSavedDescription'),
        variant: 'success',
      })
      void result
    } catch (error) {
      setFormError(getUserErrorMessage(error, t('toasts.unknownError')))
    } finally {
      setSaving(false)
    }
  }

  async function handleTestConnection() {
    setTesting(true)
    setFormError(null)
    setDiscoveryResult(null)
    try {
      const updates = buildUpdatePayload()
      // apiPost's shared handleResponse() throws on an HTTP 200 body with
      // `success: false` (this codebase's other way of saying "this
      // failed" -- see lib/api.ts) rather than resolving with it, so a
      // discovery/credential-check failure always lands in the catch below,
      // never in a `result.success === false` branch here. A resolved
      // result here means the provider actually accepted these credentials
      // (not just that discovery worked) -- see testOidcDiscovery's own
      // comment in server/services/oidc.js for the invalid_grant-is-success
      // reasoning.
      const result = await oidcSettingsApi.testConnection(updates)
      setDiscoveryResult(result.metadata)
      toast({
        title: t('toasts.testSuccessTitle'),
        description: t('toasts.testSuccessDescription'),
        variant: 'success',
      })
    } catch (error) {
      // `undetermined` (network failure, an HTML error page, an OAuth error
      // code we don't recognise) is NOT the same claim as "these
      // credentials are wrong" -- it gets its own title/tone rather than
      // collapsing into the same destructive-red "Connection failed" toast
      // a confirmed rejection gets.
      const isUndetermined = error instanceof ApiError && error.code === 'OIDC_TEST_UNDETERMINED'
      toast({
        title: isUndetermined ? t('toasts.testUndeterminedTitle') : t('toasts.testFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.unknownError')),
        variant: isUndetermined ? 'default' : 'destructive',
      })
    } finally {
      setTesting(false)
    }
  }

  // Prefills the issuer URL/scope shape for a known provider -- the
  // operator still edits in their own tenant/realm/domain. Skips a field
  // that's env-pinned (disabled in the UI below) so this can't silently
  // write to something the operator has no way to actually change.
  function handlePresetChange(id: string) {
    setSelectedPreset(id)
    setDiscoveryResult(null)
    const preset = PROVIDER_PRESETS.find((p) => p.id === id)
    if (!preset) return
    setForm((prev) => ({
      ...prev,
      issuerUrl: envOverrides?.issuerUrl ? prev.issuerUrl : preset.issuerTemplate,
      scope: envOverrides?.scope ? prev.scope : preset.scope,
    }))
  }

  async function handleUseRedirectUri() {
    if (!settings) return
    setForm((prev) => ({ ...prev, redirectUri: settings.suggestedRedirectUri }))
    const ok = await copyText(settings.suggestedRedirectUri)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const envOverrides = settings?.envOverrides

  return (
    <div className={embedded ? 'space-y-4' : 'space-y-6 page-transition'}>
      {!embedded && (
        <PageHeader
          eyebrow={t('pageHeader.eyebrow')}
          title={t('pageHeader.title')}
          description={t('pageHeader.description')}
          icon={<KeyRound className="h-6 w-6" />}
          tone="config"
        />
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : permissionDenied ? (
        <EmptyState
          type="accessDenied"
          icon={<ShieldAlert className="h-14 w-14 text-muted-foreground/40" />}
          title={t('permissionDenied.title')}
          description={t('permissionDenied.description')}
        />
      ) : loadError ? (
        <EmptyState
          type="noData"
          title={t('loadError.title')}
          description={loadError}
          action={{ label: t('loadError.retry'), onClick: fetchSettings }}
        />
      ) : settings ? (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              {settings.configured ? (
                <Badge variant="success" className="gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {t('status.configured')}
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1">
                  <XCircle className="h-3.5 w-3.5" />
                  {t('status.notConfigured')}
                </Badge>
              )}
            </div>
            {!settings.configured && (
              <CardDescription>{t('status.notConfiguredHint')}</CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-4 rounded-xl border border-border/70 bg-background/40 p-4">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{t('sections.provider')}</p>
                <p className="text-xs text-muted-foreground">{t('sections.providerDescription')}</p>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="oidc-provider-preset">{t('providerPresets.label')}</Label>
                  <Select value={selectedPreset} onValueChange={handlePresetChange}>
                    <SelectTrigger id="oidc-provider-preset">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={CUSTOM_PRESET_ID}>{t('providerPresets.custom')}</SelectItem>
                      {PROVIDER_PRESETS.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {t(`providerPresets.${preset.id}.label`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t('providerPresets.help')}</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="oidc-provider-name">{t('fields.providerName')}</Label>
                  <Input
                    id="oidc-provider-name"
                    value={form.providerName}
                    onChange={(e) => setForm((prev) => ({ ...prev, providerName: e.target.value }))}
                    placeholder={t('fields.providerNamePlaceholder')}
                    disabled={envOverrides?.providerName}
                  />
                  <p className="text-xs text-muted-foreground">
                    {envOverrides?.providerName ? t('envPinnedNote') : t('fields.providerNameHelp')}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="oidc-issuer-url">{t('fields.issuerUrl')}</Label>
                <Input
                  id="oidc-issuer-url"
                  value={form.issuerUrl}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, issuerUrl: e.target.value }))
                    setDiscoveryResult(null)
                  }}
                  placeholder={t('fields.issuerUrlPlaceholder')}
                  disabled={envOverrides?.issuerUrl}
                />
                <p className="text-xs text-muted-foreground">
                  {envOverrides?.issuerUrl ? t('envPinnedNote') : t('fields.issuerUrlHelp')}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="oidc-redirect-uri">{t('fields.redirectUri')}</Label>
                <Input
                  id="oidc-redirect-uri"
                  value={form.redirectUri}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, redirectUri: e.target.value }))
                    setDiscoveryResult(null)
                  }}
                  disabled={envOverrides?.redirectUri}
                />
                {envOverrides?.redirectUri ? (
                  <p className="text-xs text-muted-foreground">{t('envPinnedNote')}</p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/[0.04] px-2.5 py-2 text-xs">
                      <span className="text-muted-foreground">{t('fields.redirectUriHelp')}</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground/85">
                        {settings.suggestedRedirectUri}
                      </code>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="ms-auto h-7 gap-1.5 px-2 text-xs"
                        onClick={handleUseRedirectUri}
                      >
                        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        {t('fields.useAndCopy')}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">{t('fields.redirectUriConfirmNote')}</p>
                  </>
                )}
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="oidc-client-id">{t('fields.clientId')}</Label>
                    <HelpTip label={t('fields.clientId')}>{t('fields.clientIdHelp')}</HelpTip>
                  </div>
                  <Input
                    id="oidc-client-id"
                    value={form.clientId}
                    onChange={(e) => {
                      setForm((prev) => ({ ...prev, clientId: e.target.value }))
                      setDiscoveryResult(null)
                    }}
                    disabled={envOverrides?.clientId}
                  />
                  {envOverrides?.clientId && (
                    <p className="text-xs text-muted-foreground">{t('envPinnedNote')}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="oidc-client-secret">{t('fields.clientSecret')}</Label>
                  <Input
                    id="oidc-client-secret"
                    type="password"
                    value={clientSecret}
                    onChange={(e) => {
                      setClientSecret(e.target.value)
                      setDiscoveryResult(null)
                    }}
                    placeholder={
                      settings.clientSecretConfigured
                        ? t('fields.clientSecretPlaceholderConfigured')
                        : t('fields.clientSecretPlaceholderEmpty')
                    }
                    disabled={envOverrides?.clientSecret}
                  />
                  {envOverrides?.clientSecret ? (
                    <p className="text-xs text-muted-foreground">{t('envPinnedNote')}</p>
                  ) : settings.clientSecretConfigured ? (
                    <p className="text-xs text-muted-foreground">{t('fields.clientSecretConfiguredHelp')}</p>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="space-y-4 rounded-xl border border-border/70 bg-background/40 p-4">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{t('sections.advanced')}</p>
                <p className="text-xs text-muted-foreground">{t('sections.advancedDescription')}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="oidc-scope">{t('fields.scope')}</Label>
                <Input
                  id="oidc-scope"
                  value={form.scope}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, scope: e.target.value }))
                    setDiscoveryResult(null)
                  }}
                  disabled={envOverrides?.scope}
                />
                <p className="text-xs text-muted-foreground">
                  {envOverrides?.scope ? t('envPinnedNote') : t('fields.scopeHelp')}
                </p>
              </div>

              <div className="flex items-start justify-between gap-4 rounded-md border border-border/60 p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="oidc-allow-insecure-http">{t('fields.allowInsecureHttp')}</Label>
                  <p className="text-xs text-muted-foreground">{t('fields.allowInsecureHttpHelp')}</p>
                  {envOverrides?.allowInsecureHttp && (
                    <p className="text-xs text-muted-foreground">{t('envPinnedNote')}</p>
                  )}
                </div>
                <Switch
                  id="oidc-allow-insecure-http"
                  checked={allowInsecureHttp}
                  onCheckedChange={setAllowInsecureHttp}
                  disabled={envOverrides?.allowInsecureHttp}
                />
              </div>
            </div>

            {formError && <p className="text-sm text-destructive">{formError}</p>}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button onClick={handleSave} disabled={saving || testing}>
                {saving ? t('actions.saving') : t('actions.save')}
              </Button>
              <Button variant="outline" onClick={handleTestConnection} disabled={saving || testing}>
                {testing ? t('actions.testing') : t('actions.testConnection')}
              </Button>
            </div>

            {discoveryResult && (
              <div className="space-y-2.5 rounded-lg border border-primary/25 bg-primary/[0.03] p-4 text-sm">
                <p className="font-medium text-foreground">{t('discoveryResult.title')}</p>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                  <div className="min-w-0 space-y-0.5">
                    <dt className="text-xs text-muted-foreground">{t('discoveryResult.issuer')}</dt>
                    <dd className="break-all font-mono text-xs">{discoveryResult.issuer}</dd>
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <dt className="text-xs text-muted-foreground">{t('discoveryResult.authorizationEndpoint')}</dt>
                    <dd className="break-all font-mono text-xs">
                      {discoveryResult.authorizationEndpoint || t('discoveryResult.notAvailable')}
                    </dd>
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <dt className="text-xs text-muted-foreground">{t('discoveryResult.tokenEndpoint')}</dt>
                    <dd className="break-all font-mono text-xs">
                      {discoveryResult.tokenEndpoint || t('discoveryResult.notAvailable')}
                    </dd>
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <dt className="text-xs text-muted-foreground">{t('discoveryResult.userinfoEndpoint')}</dt>
                    <dd className="break-all font-mono text-xs">
                      {discoveryResult.userinfoEndpoint || t('discoveryResult.notAvailable')}
                    </dd>
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <dt className="text-xs text-muted-foreground">{t('discoveryResult.jwksUri')}</dt>
                    <dd className="break-all font-mono text-xs">{discoveryResult.jwksUri || t('discoveryResult.notAvailable')}</dd>
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <dt className="text-xs text-muted-foreground">{t('discoveryResult.scopesSupported')}</dt>
                    <dd className="break-all font-mono text-xs">
                      {discoveryResult.scopesSupported.length > 0
                        ? discoveryResult.scopesSupported.join(', ')
                        : t('discoveryResult.scopesNone')}
                    </dd>
                  </div>
                </dl>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
