import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  KeyRound,
  ShieldAlert,
  Loader2,
  Copy,
  Check,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardHeader,
  CardDescription,
  CardContent,
} from '@/components/ui/card'
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
import { panelQueryKeys } from '@/lib/queryClient'

interface ProviderPreset {
  id: string
  issuerTemplate: string
  scope: string
}
const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'google',
    issuerTemplate: 'https://accounts.google.com',
    scope: 'openid email profile',
  },
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
  {
    id: 'okta',
    issuerTemplate: 'https://<okta-domain>/oauth2/default',
    scope: 'openid email profile',
  },
  {
    id: 'auth0',
    issuerTemplate: 'https://<your-domain>.auth0.com/',
    scope: 'openid email profile',
  },
]
const CUSTOM_PRESET_ID = 'custom'

const MASKED_SECRET_SENTINEL = '••••••••'

const FIELD_KEYS = [
  'issuerUrl',
  'clientId',
  'redirectUri',
  'scope',
  'providerName',
] as const satisfies readonly (keyof OidcSettingsFields)[]
type FieldKey = (typeof FIELD_KEYS)[number]

type UncoveredOidcSettingsField = Exclude<
  keyof OidcSettingsFields,
  FieldKey | 'allowInsecureHttp'
>
const _assertFieldKeysCoversOidcSettingsFields: UncoveredOidcSettingsField extends never
  ? true
  : { MISSING_FROM_FIELD_KEYS: UncoveredOidcSettingsField } = true
void _assertFieldKeysCoversOidcSettingsFields

export default function OidcSettings({
  embedded = false,
}: {
  embedded?: boolean
}) {
  const { toast } = useToast()

  const {
    data: settings,
    error: settingsError,
    refetch: refetchSettings,
    isPending: settingsPending,
  } = useQuery({
    queryKey: panelQueryKeys.oidcSettings,
    queryFn: oidcSettingsApi.get,
    retry: false,
    staleTime: 30_000,
  })
  const loading = settingsPending
  const permissionDenied =
    settingsError instanceof ApiError && settingsError.status === 403
  const loadError =
    !permissionDenied && settingsError
      ? getUserErrorMessage(settingsError, 'Unknown error')
      : null

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
  const [discoveryResult, setDiscoveryResult] =
    useState<OidcDiscoveredMetadata | null>(null)

  const applySettings = (data: OidcSettingsWithEnv) => {
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

  useEffect(() => {
    if (settings) applySettings(settings)
  }, [settings])

  const fetchSettings = useCallback(async () => {
    await refetchSettings()
  }, [refetchSettings])

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
        title: 'Sign-in settings saved',
        description:
          'The panel will use the new settings for the next sign-in attempt.',
        variant: 'success',
      })
      void result
    } catch (error) {
      setFormError(getUserErrorMessage(error, 'Unknown error'))
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
      const result = await oidcSettingsApi.testConnection(updates)
      setDiscoveryResult(result.metadata)
      toast({
        title: 'Connection successful',
        description:
          'The panel reached the identity provider and confirmed it accepts these credentials.',
        variant: 'success',
      })
    } catch (error) {
      const isUndetermined =
        error instanceof ApiError && error.code === 'OIDC_TEST_UNDETERMINED'
      toast({
        title: isUndetermined ? 'Could not confirm' : 'Connection failed',
        description: getUserErrorMessage(error, 'Unknown error'),
        variant: isUndetermined ? 'default' : 'destructive',
      })
    } finally {
      setTesting(false)
    }
  }

  function handlePresetChange(id: string) {
    setSelectedPreset(id)
    setDiscoveryResult(null)
    const preset = PROVIDER_PRESETS.find((p) => p.id === id)
    if (!preset) return
    setForm((prev) => ({
      ...prev,
      issuerUrl: envOverrides?.issuerUrl
        ? prev.issuerUrl
        : preset.issuerTemplate,
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
          eyebrow={'Identity'}
          title={'Sign-in'}
          description={
            'Let people sign in with an existing account from an identity provider (Google Workspace, Okta, Authentik, and similar), instead of — never instead of — a username and password. Local sign-in always keeps working.'
          }
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
          title={"You can't manage sign-in settings"}
          description={
            'Your account\'s role doesn\'t include "Manage panel-wide settings". Ask an administrator to grant it if you need access to this screen.'
          }
        />
      ) : loadError ? (
        <EmptyState
          type="noData"
          title={"Couldn't load sign-in settings"}
          description={loadError}
          action={{ label: 'Try again', onClick: fetchSettings }}
        />
      ) : settings ? (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              {settings.configured ? (
                <Badge variant="success" className="gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {'Single sign-on is configured'}
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1">
                  <XCircle className="h-3.5 w-3.5" />
                  {'Single sign-on is not configured yet'}
                </Badge>
              )}
            </div>
            {!settings.configured && (
              <CardDescription>
                {'Fill in the provider details below and save to turn it on.'}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-4 rounded-xl border border-border/70 bg-background/40 p-4">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {'Provider'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {
                    'How this panel connects to your identity provider, and what to register there.'
                  }
                </p>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="oidc-provider-preset">
                    {'Provider preset'}
                  </Label>
                  <Select
                    value={selectedPreset}
                    onValueChange={handlePresetChange}
                  >
                    <SelectTrigger id="oidc-provider-preset">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={CUSTOM_PRESET_ID}>
                        {'Custom / other'}
                      </SelectItem>
                      {PROVIDER_PRESETS.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {(
                            {
                              google: 'Google',
                              authentik: 'Authentik',
                              keycloak: 'Keycloak',
                              azuread: 'Azure AD (Microsoft Entra ID)',
                              okta: 'Okta',
                              auth0: 'Auth0',
                            } as Record<string, string>
                          )[String(preset.id)] ?? String(preset.id)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {
                      'Fills in the issuer URL shape and recommended scope for a known provider. Replace anything in angle brackets with your own values before testing or saving.'
                    }
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="oidc-provider-name">{'Display name'}</Label>
                  <Input
                    id="oidc-provider-name"
                    value={form.providerName}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        providerName: e.target.value,
                      }))
                    }
                    placeholder={'e.g. Google, Okta, Authentik'}
                    disabled={envOverrides?.providerName}
                  />
                  <p className="text-xs text-muted-foreground">
                    {envOverrides?.providerName
                      ? 'Set via an environment variable on this install — edit it there, not here.'
                      : 'Shown on the login button, such as “Continue with Authentik”.'}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="oidc-issuer-url">{'Issuer URL'}</Label>
                <Input
                  id="oidc-issuer-url"
                  value={form.issuerUrl}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, issuerUrl: e.target.value }))
                    setDiscoveryResult(null)
                  }}
                  placeholder={'https://accounts.example.com'}
                  disabled={envOverrides?.issuerUrl}
                />
                <p className="text-xs text-muted-foreground">
                  {envOverrides?.issuerUrl
                    ? 'Set via an environment variable on this install — edit it there, not here.'
                    : 'The base URL your identity provider gave you for OpenID Connect — the panel discovers everything else from it.'}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="oidc-redirect-uri">{'Redirect URI'}</Label>
                <Input
                  id="oidc-redirect-uri"
                  value={form.redirectUri}
                  onChange={(e) => {
                    setForm((prev) => ({
                      ...prev,
                      redirectUri: e.target.value,
                    }))
                    setDiscoveryResult(null)
                  }}
                  disabled={envOverrides?.redirectUri}
                />
                {envOverrides?.redirectUri ? (
                  <p className="text-xs text-muted-foreground">
                    {
                      'Set via an environment variable on this install — edit it there, not here.'
                    }
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/[0.04] px-2.5 py-2 text-xs">
                      <span className="text-muted-foreground">
                        {
                          "Paste this exact URL into your identity provider's app registration:"
                        }
                      </span>
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
                        {copied ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        {'Use & copy'}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {
                        "Double-check this matches the web address you actually use to reach this panel — especially http vs. https. Behind a reverse proxy, the panel can't always tell which one your browser used."
                      }
                    </p>
                  </>
                )}
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="oidc-client-id">{'Client ID'}</Label>
                    <HelpTip label={'Client ID'}>
                      {
                        "The public identifier your identity provider assigned to this panel when you registered it as an application there — paired with the client secret below, but not sensitive on its own. Copy it from your provider's app registration page."
                      }
                    </HelpTip>
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
                    <p className="text-xs text-muted-foreground">
                      {
                        'Set via an environment variable on this install — edit it there, not here.'
                      }
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="oidc-client-secret">{'Client secret'}</Label>
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
                        ? 'Leave unchanged to keep the current secret'
                        : 'Enter the client secret'
                    }
                    disabled={envOverrides?.clientSecret}
                  />
                  {envOverrides?.clientSecret ? (
                    <p className="text-xs text-muted-foreground">
                      {
                        'Set via an environment variable on this install — edit it there, not here.'
                      }
                    </p>
                  ) : settings.clientSecretConfigured ? (
                    <p className="text-xs text-muted-foreground">
                      {
                        "A secret is already stored — these dots aren't the real value. Leave them as-is to keep it, type a new value to replace it, or clear the field and save to remove sign-in with this provider."
                      }
                    </p>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="space-y-4 rounded-xl border border-border/70 bg-background/40 p-4">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {'Advanced'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {
                    'Scope and transport options — leave as-is unless your provider needs something different.'
                  }
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="oidc-scope">{'Scope'}</Label>
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
                  {envOverrides?.scope
                    ? 'Set via an environment variable on this install — edit it there, not here.'
                    : 'Advanced. Leave as-is unless your provider needs something different.'}
                </p>
              </div>

              <div className="flex items-start justify-between gap-4 rounded-md border border-border/60 p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="oidc-allow-insecure-http">
                    {'Allow plain HTTP for this provider'}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {
                      'Only for a self-hosted identity provider reachable solely over a private, HTTP-only address (e.g. behind a VPN). Never enable this for a provider reachable from the internet.'
                    }
                  </p>
                  {envOverrides?.allowInsecureHttp && (
                    <p className="text-xs text-muted-foreground">
                      {
                        'Set via an environment variable on this install — edit it there, not here.'
                      }
                    </p>
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

            {formError && (
              <p className="text-sm text-destructive">{formError}</p>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button onClick={handleSave} disabled={saving || testing}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button
                variant="outline"
                onClick={handleTestConnection}
                disabled={saving || testing}
              >
                {testing ? 'Testing…' : 'Test Connection'}
              </Button>
            </div>

            {discoveryResult && (
              <div className="space-y-2.5 rounded-lg border border-primary/25 bg-primary/[0.03] p-4 text-sm">
                <p className="font-medium text-foreground">
                  {'What the provider returned'}
                </p>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                  <div className="min-w-0 space-y-0.5">
                    <dt className="text-xs text-muted-foreground">
                      {'Issuer'}
                    </dt>
                    <dd className="break-all font-mono text-xs">
                      {discoveryResult.issuer}
                    </dd>
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <dt className="text-xs text-muted-foreground">
                      {'Authorization endpoint'}
                    </dt>
                    <dd className="break-all font-mono text-xs">
                      {discoveryResult.authorizationEndpoint ||
                        'Not advertised'}
                    </dd>
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <dt className="text-xs text-muted-foreground">
                      {'Token endpoint'}
                    </dt>
                    <dd className="break-all font-mono text-xs">
                      {discoveryResult.tokenEndpoint || 'Not advertised'}
                    </dd>
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <dt className="text-xs text-muted-foreground">
                      {'Userinfo endpoint'}
                    </dt>
                    <dd className="break-all font-mono text-xs">
                      {discoveryResult.userinfoEndpoint || 'Not advertised'}
                    </dd>
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <dt className="text-xs text-muted-foreground">
                      {'JWKS URI'}
                    </dt>
                    <dd className="break-all font-mono text-xs">
                      {discoveryResult.jwksUri || 'Not advertised'}
                    </dd>
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <dt className="text-xs text-muted-foreground">
                      {'Scopes advertised'}
                    </dt>
                    <dd className="break-all font-mono text-xs">
                      {discoveryResult.scopesSupported.length > 0
                        ? discoveryResult.scopesSupported.join(', ')
                        : 'Not advertised'}
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
