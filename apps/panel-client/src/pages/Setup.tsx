import { useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { getUserErrorMessage } from '../lib/errorMessage'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Checkbox } from '../components/ui/checkbox'
import { AuthScreenLayout } from '../components/AuthScreenLayout'
import { HelpTip } from '../components/HelpTip'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RadioTower,
  Server,
  ShieldCheck,
  ShieldAlert,
  XCircle,
} from 'lucide-react'

type StrengthKey = 'tooShort' | 'weak' | 'fair' | 'good' | 'strong'

type PasswordStrength = {
  score: 0 | 1 | 2 | 3 | 4
  key: StrengthKey | null
  tone: 'empty' | 'weak' | 'fair' | 'good' | 'strong'
}

function scorePassword(pw: string): PasswordStrength {
  if (!pw) return { score: 0, key: null, tone: 'empty' }
  let score = 0
  if (pw.length >= 6) score++
  if (pw.length >= 10) score++
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++
  if (pw.length >= 14) score = Math.min(4, score + 1)
  const map: Record<number, PasswordStrength> = {
    0: { score: 1, key: 'tooShort', tone: 'weak' },
    1: { score: 1, key: 'weak', tone: 'weak' },
    2: { score: 2, key: 'fair', tone: 'fair' },
    3: { score: 3, key: 'good', tone: 'good' },
    4: { score: 4, key: 'strong', tone: 'strong' },
  }
  return map[Math.min(4, score) as 0 | 1 | 2 | 3 | 4]
}

export default function Setup() {
  const { setup } = useAuth()
  const [username, setUsername] = useState('admin')
  const [setupToken, setSetupToken] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [panelPort, setPanelPort] = useState('3001')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [capsLockOn, setCapsLockOn] = useState(false)
  const errorId = error ? 'setup-error' : undefined
  const usernameHintId = 'setup-username-hint'
  const passwordHintId = 'setup-password-hint'
  const confirmHintId = 'setup-confirm-hint'

  const passwordsMatch = password === confirmPassword
  const passwordLongEnough = password.length >= 6
  const usernameValid = /^[a-zA-Z0-9_-]{3,32}$/.test(username)
  const panelPortNumber = Number(panelPort)
  const panelPortValid =
    Number.isInteger(panelPortNumber) &&
    panelPortNumber >= 1024 &&
    panelPortNumber <= 65535
  const strength = useMemo(() => scorePassword(password), [password])

  const detectCaps = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (typeof e.getModifierState === 'function') {
      setCapsLockOn(e.getModifierState('CapsLock'))
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!setupToken.trim()) {
      setError(
        "Enter the setup token printed to the panel's startup log or console output.",
      )
      return
    }
    if (!usernameValid) {
      setError('Username must be 3-32 characters (letters, numbers, _ or -)')
      return
    }
    if (!passwordLongEnough) {
      setError('Password must be at least 6 characters')
      return
    }
    if (!passwordsMatch) {
      setError('Passwords do not match')
      return
    }
    if (!panelPortValid) {
      setError('Panel port must be a whole number between 1024 and 65535')
      return
    }

    setLoading(true)
    try {
      await setup(username, password, rememberMe, panelPort, setupToken.trim())
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      setError(
        message === 'SETUP_TOKEN_REQUIRED'
          ? "Invalid or missing setup token. Check the panel's startup log or console output for the one-time token."
          : getUserErrorMessage(err, 'Setup failed'),
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthScreenLayout
      badge={'Initial Provisioning'}
      title={'Zomboid Control Panel'}
      description={
        'Create the first admin account for this panel, then continue to the rest of setup.'
      }
      cardTitle={'Create Admin Account'}
      cardDescription={
        'This account unlocks the control panel and signs you in right away.'
      }
      footer={
        <span className="inline-flex items-start gap-1.5 text-start">
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning/80"
            aria-hidden="true"
          />
          <span>
            {
              'Store this password safely. There is no email recovery — resetting it later requires filesystem access to this server.'
            }
          </span>
        </span>
      }
    >
      <ol
        className="-mt-1 mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground"
        aria-label={'Setup progress'}
      >
        <li className="flex items-center gap-1.5">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-primary/40 bg-primary/15 text-[10px] font-semibold text-primary">
            1
          </span>
          <span className="text-foreground/80">{'Account'}</span>
        </li>
        <span aria-hidden="true" className="h-px w-6 bg-border/60" />
        <li className="flex items-center gap-1.5 opacity-70">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border/60 bg-muted/20 text-[10px] font-semibold text-muted-foreground">
            2
          </span>
          <span>{'Server'}</span>
        </li>
        <span aria-hidden="true" className="h-px w-6 bg-border/60" />
        <li className="flex items-center gap-1.5 opacity-50">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border/60 bg-muted/20 text-[10px] font-semibold text-muted-foreground">
            3
          </span>
          <span>{'Online'}</span>
        </li>
      </ol>

      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div
            id="setup-error"
            role="alert"
            aria-live="assertive"
            className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/8 px-3 py-2.5 text-sm text-destructive"
          >
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <div className="space-y-2 rounded-lg border border-primary/25 bg-primary/5 p-3">
          <Label htmlFor="setupToken" className="flex items-center gap-1.5">
            <ShieldAlert
              className="h-3.5 w-3.5 text-primary"
              aria-hidden="true"
            />
            {'Setup Token'}
          </Label>
          <Input
            id="setupToken"
            type="text"
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            placeholder={'Paste the token from the startup log'}
            autoComplete="off"
            disabled={loading}
            aria-describedby="setup-token-hint"
            required
          />
          <p
            id="setup-token-hint"
            className="text-xs leading-5 text-muted-foreground"
          >
            {
              "Printed to the panel's startup log or console output the first time it runs, to prove you're the one setting it up. Restart the panel to print it again if you've lost it."
            }
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="username">{'Username'}</Label>
          <Input
            id="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={'admin'}
            autoComplete="username"
            autoFocus
            maxLength={32}
            disabled={loading}
            aria-describedby={[usernameHintId, errorId]
              .filter(Boolean)
              .join(' ')}
            aria-invalid={Boolean(error && !usernameValid)}
            required
          />
          <div
            id={usernameHintId}
            className="flex items-center gap-1.5 text-xs leading-5"
          >
            {username.length === 0 ? (
              <span className="text-muted-foreground">
                {
                  'Use 3-32 characters: letters, numbers, underscores, or hyphens.'
                }
              </span>
            ) : usernameValid ? (
              <>
                <CheckCircle
                  className="h-3.5 w-3.5 text-primary"
                  aria-hidden="true"
                />
                <span className="text-primary">{'Looks good.'}</span>
              </>
            ) : (
              <>
                <div
                  className="h-3.5 w-3.5 rounded-full border border-destructive"
                  aria-hidden="true"
                />
                <span className="text-destructive">
                  {'3-32 chars; letters, numbers, _ or - only.'}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="panelPort">{'Panel Port'}</Label>
          <Input
            id="panelPort"
            type="number"
            value={panelPort}
            onChange={(e) => setPanelPort(e.target.value)}
            min="1024"
            max="65535"
            inputMode="numeric"
            disabled={loading}
            aria-invalid={Boolean(error && !panelPortValid)}
            required
          />
          <p className="text-xs leading-5 text-muted-foreground">
            {
              'Port used to open the panel. Default: 3001. If it is busy, the panel will choose and save a free port automatically.'
            }
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">{'Password'}</Label>
            {capsLockOn && (
              <span
                className="inline-flex items-center gap-1 text-[11px] font-medium text-warning"
                role="status"
              >
                <KeyRound className="h-3 w-3" aria-hidden="true" />
                {'Caps Lock is on'}
              </span>
            )}
          </div>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={detectCaps}
              onKeyUp={detectCaps}
              onBlur={() => setCapsLockOn(false)}
              placeholder="••••••••"
              autoComplete="new-password"
              disabled={loading}
              aria-describedby={[passwordHintId, errorId]
                .filter(Boolean)
                .join(' ')}
              aria-invalid={Boolean(error && !passwordLongEnough)}
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              title={showPassword ? 'Hide password' : 'Show password'}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
            >
              {showPassword ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          </div>

          <div id={passwordHintId} className="space-y-1.5">
            <div className="flex items-center gap-1" aria-hidden="true">
              {[1, 2, 3, 4].map((i) => {
                const filled = strength.score >= i
                const tone = strength.tone
                const cls = !filled
                  ? 'bg-muted/40'
                  : tone === 'weak'
                    ? 'bg-destructive/70'
                    : tone === 'fair'
                      ? 'bg-warning/70'
                      : tone === 'good'
                        ? 'bg-primary/70'
                        : 'bg-success/80'
                return (
                  <span
                    key={i}
                    className={`h-1 flex-1 rounded-full transition-colors duration-200 ${cls}`}
                  />
                )
              })}
            </div>
            <div className="flex items-center justify-between text-xs leading-5">
              <span className="flex items-center gap-1.5">
                {passwordLongEnough ? (
                  <CheckCircle
                    className="h-3.5 w-3.5 text-primary"
                    aria-hidden="true"
                  />
                ) : (
                  <div
                    className="h-3.5 w-3.5 rounded-full border border-muted-foreground/30"
                    aria-hidden="true"
                  />
                )}
                <span
                  className={
                    passwordLongEnough
                      ? 'text-primary'
                      : 'text-muted-foreground'
                  }
                >
                  {'Use at least 6 characters.'}
                </span>
              </span>
              {strength.key && (
                <span
                  className={
                    strength.tone === 'weak'
                      ? 'text-destructive'
                      : strength.tone === 'fair'
                        ? 'text-warning'
                        : strength.tone === 'good'
                          ? 'text-primary'
                          : 'text-success'
                  }
                  aria-live="polite"
                >
                  {(
                    {
                      tooShort: 'Too short',
                      weak: 'Weak',
                      fair: 'Fair',
                      good: 'Good',
                      strong: 'Strong',
                    } as Record<string, string>
                  )[String(strength.key)] ?? String(strength.key)}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirmPassword">{'Confirm Password'}</Label>
          <Input
            id="confirmPassword"
            type={showPassword ? 'text' : 'password'}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            onKeyDown={detectCaps}
            onKeyUp={detectCaps}
            onBlur={() => setCapsLockOn(false)}
            placeholder="••••••••"
            autoComplete="new-password"
            disabled={loading}
            aria-describedby={[confirmHintId, errorId]
              .filter(Boolean)
              .join(' ')}
            aria-invalid={Boolean(confirmPassword && !passwordsMatch)}
            required
          />
          {confirmPassword && (
            <div
              id={confirmHintId}
              className="flex items-center gap-1.5 text-xs leading-5"
            >
              {passwordsMatch ? (
                <CheckCircle
                  className="w-3.5 h-3.5 text-primary"
                  aria-hidden="true"
                />
              ) : (
                <div
                  className="h-3.5 w-3.5 rounded-full border border-destructive"
                  aria-hidden="true"
                />
              )}
              <span
                className={passwordsMatch ? 'text-primary' : 'text-destructive'}
              >
                {passwordsMatch ? 'Passwords match' : 'Passwords do not match'}
              </span>
            </div>
          )}
          {!confirmPassword && (
            <p
              id={confirmHintId}
              className="text-xs leading-5 text-muted-foreground"
            >
              {'Type the same password again to confirm it.'}
            </p>
          )}
        </div>

        <div className="flex items-center space-x-2 rounded-lg border border-border/60 bg-muted/15 px-3 py-2.5">
          <Checkbox
            id="rememberMe"
            checked={rememberMe}
            onCheckedChange={(checked) => setRememberMe(checked === true)}
          />
          <Label
            htmlFor="rememberMe"
            className="flex cursor-pointer items-center gap-1.5 text-sm font-normal text-foreground/90"
          >
            {'Keep me signed in on this browser'}
          </Label>
          <HelpTip label={'Keep me signed in on this browser'}>
            {
              'Skips the login screen next time you open the panel in this browser. Leave this off on a shared or public computer — anyone who uses that browser afterward would be able to control this server without a password.'
            }
          </HelpTip>
        </div>

        <Button
          type="submit"
          className="w-full onboarding-cta"
          disabled={
            loading ||
            !setupToken.trim() ||
            !usernameValid ||
            !passwordLongEnough ||
            !passwordsMatch ||
            !panelPortValid
          }
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {'Creating admin account...'}
            </>
          ) : (
            <>
              {'Create account & continue'}
              <ArrowRight className="ms-1 h-4 w-4" aria-hidden="true" />
            </>
          )}
        </Button>

        <div className="mission-brief rounded-xl border border-border/60 bg-muted/10 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <ArrowRight className="h-4 w-4 text-primary" aria-hidden="true" />
              {'After this step'}
            </div>
            <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              {'Preview'}
            </span>
          </div>
          <div className="mission-step-grid mt-3 space-y-2">
            <div className="mission-step-card flex items-start gap-3 rounded-lg border border-border/50 bg-background/35 px-3 py-2.5">
              <div className="mission-step-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                <Server className="h-3.5 w-3.5" aria-hidden="true" />
              </div>
              <div className="min-w-0 pt-0.5">
                <p className="text-[13px] font-medium leading-tight text-foreground">
                  {'Bring a server into the panel'}
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  {
                    'Add an existing install or run the guided setup to create one.'
                  }
                </p>
              </div>
            </div>

            <div className="mission-step-card flex items-start gap-3 rounded-lg border border-border/50 bg-background/35 px-3 py-2.5">
              <div className="mission-step-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              </div>
              <div className="min-w-0 pt-0.5">
                <p className="text-[13px] font-medium leading-tight text-foreground">
                  {'Confirm RCON and paths'}
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  {
                    'The panel needs to authenticate against the server before it can do anything useful.'
                  }
                </p>
              </div>
            </div>

            <div className="mission-step-card flex items-start gap-3 rounded-lg border border-border/50 bg-background/35 px-3 py-2.5">
              <div className="mission-step-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                <RadioTower className="h-3.5 w-3.5" aria-hidden="true" />
              </div>
              <div className="min-w-0 pt-0.5">
                <p className="text-[13px] font-medium leading-tight text-foreground">
                  {'Take the dashboard live'}
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  {
                    'Verify status, players, backups, and quick admin actions from one screen.'
                  }
                </p>
              </div>
            </div>
          </div>
        </div>
      </form>
    </AuthScreenLayout>
  )
}
