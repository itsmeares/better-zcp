import { useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { getUserErrorMessage } from '../lib/errorMessage'
import { ArrowRight } from 'lucide-react'
import { cn } from '../lib/utils'
import { AuthScreenLayout } from '../components/AuthScreenLayout'
import { HelpTip } from '../components/HelpTip'
import { PasswordInput } from '../components/PasswordInput'
import { Alert, AlertDescription } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Spinner } from '../components/ui/spinner'

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

  const strengthLabel = strength.key && { tooShort: 'Too short', weak: 'Weak', fair: 'Fair', good: 'Good', strong: 'Strong' }[strength.key]
  const strengthColor = { empty: 'bg-muted', weak: 'bg-destructive', fair: 'bg-warning', good: 'bg-primary', strong: 'bg-success' }[strength.tone]
  const hint = (ok: boolean, text: string) => <p className={cn('text-xs', ok ? 'text-success-foreground' : 'text-muted-foreground')}>{text}</p>
  const capsProps = { onKeyDown: detectCaps, onKeyUp: detectCaps, onBlur: () => setCapsLockOn(false) }

  return (
    <AuthScreenLayout
      title="Create the admin account"
      description="This account unlocks the panel and signs you in. Next you add your first server."
      footer="Keep this password safe. There is no email recovery. Resetting it later needs access to the panel's files."
    >
      <form onSubmit={handleSubmit} className="grid gap-4">
        {error && (
          <Alert variant="error" id="setup-error" aria-live="assertive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-2">
          <Label htmlFor="setupToken">Setup token</Label>
          <Input id="setupToken" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} placeholder="Paste the token from the startup log" autoComplete="off" disabled={loading} aria-describedby="setup-token-hint" required />
          <p id="setup-token-hint" className="text-xs text-muted-foreground">
            The panel prints it to its startup log the first time it runs, to prove you're the one setting it up. Restart the panel to print it again.
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="username">Username</Label>
          <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" autoComplete="username" autoFocus maxLength={32} disabled={loading} aria-describedby={[usernameHintId, errorId].filter(Boolean).join(' ')} aria-invalid={username.length > 0 && !usernameValid} required />
          <div id={usernameHintId}>{hint(usernameValid, username.length > 0 && !usernameValid ? '3 to 32 letters, numbers, _ or -. Nothing else.' : '3 to 32 letters, numbers, underscores or hyphens.')}</div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="panelPort">Panel port</Label>
          <Input id="panelPort" type="number" value={panelPort} onChange={(e) => setPanelPort(e.target.value)} min={1024} max={65535} inputMode="numeric" disabled={loading} aria-invalid={!panelPortValid} required />
          <p className="text-xs text-muted-foreground">The port you open the panel on. If 3001 is busy, the panel picks a free one and saves it.</p>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            {capsLockOn && (
              <span role="status" className="text-xs text-warning-foreground">
                Caps Lock is on
              </span>
            )}
          </div>
          <PasswordInput id="password" value={password} onChange={setPassword} {...capsProps} autoComplete="new-password" disabled={loading} aria-describedby={[passwordHintId, errorId].filter(Boolean).join(' ')} aria-invalid={Boolean(error && !passwordLongEnough)} required maxLength={128} />
          <div id={passwordHintId} className="grid gap-1.5">
            <div className="grid grid-cols-4 gap-1" aria-hidden>
              {[1, 2, 3, 4].map((step) => (
                <span key={step} className={cn('h-1 rounded-full', strength.score >= step ? strengthColor : 'bg-muted')} />
              ))}
            </div>
            <div className="flex justify-between">
              {hint(passwordLongEnough, 'At least 6 characters.')}
              {strengthLabel && (
                <span className="text-xs text-muted-foreground" aria-live="polite">
                  {strengthLabel}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="confirmPassword">Confirm password</Label>
          <PasswordInput id="confirmPassword" label="password confirmation" value={confirmPassword} onChange={setConfirmPassword} {...capsProps} autoComplete="new-password" disabled={loading} aria-describedby={[confirmHintId, errorId].filter(Boolean).join(' ')} aria-invalid={Boolean(confirmPassword && !passwordsMatch)} required maxLength={128} />
          <div id={confirmHintId}>
            {confirmPassword ? (
              passwordsMatch ? (
                hint(true, 'The passwords match.')
              ) : (
                <p className="text-xs text-destructive-foreground">The passwords don't match.</p>
              )
            ) : (
              hint(false, 'Type the same password again.')
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Label className="font-normal">
            <Checkbox id="rememberMe" checked={rememberMe} onCheckedChange={(checked) => setRememberMe(checked === true)} />
            Keep me signed in on this browser
          </Label>
          <HelpTip label="Keep me signed in on this browser">
            Skips the sign-in screen next time in this browser. Leave it off on a shared computer, or anyone who uses that browser later can control your servers without a password.
          </HelpTip>
        </div>
        <Button type="submit" disabled={loading || !setupToken.trim() || !usernameValid || !passwordLongEnough || !passwordsMatch || !panelPortValid}>
          {loading && <Spinner />}
          {loading ? 'Creating the account…' : 'Create account & continue'}
          {!loading && <ArrowRight />}
        </Button>
      </form>
    </AuthScreenLayout>
  )
}
