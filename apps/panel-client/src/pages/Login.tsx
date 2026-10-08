import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import {
  rawErrorMessageIntentional,
  getUserErrorMessage,
} from '../lib/errorMessage'
import { ApiError } from '../lib/ApiError'
import { ArrowLeft, KeyRound } from 'lucide-react'
import { AuthScreenLayout } from '../components/AuthScreenLayout'
import { PasswordInput } from '../components/PasswordInput'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Spinner } from '../components/ui/spinner'

const LOGIN_DEVICE_FAILURE_KEY = 'pz-login-failed-attempts'
const DEVICE_HINT_THRESHOLD = 3

function readDeviceFailureCount(): number {
  try {
    return Number(localStorage.getItem(LOGIN_DEVICE_FAILURE_KEY)) || 0
  } catch {
    return 0
  }
}

export default function Login() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const errorId = error ? 'login-error' : undefined
  const [deviceFailedAttempts, setDeviceFailedAttempts] = useState(
    readDeviceFailureCount,
  )

  const [resetMode, setResetMode] = useState(false)
  const [resetAvailable, setResetAvailable] = useState(false)
  const [resetToken, setResetToken] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [resetSuccess, setResetSuccess] = useState('')
  const [localResetSupported, setLocalResetSupported] = useState(false)
  const [showRecoveryHelp, setShowRecoveryHelp] = useState(false)
  const [checkingResetStatus, setCheckingResetStatus] = useState(false)
  const [creatingLocalReset, setCreatingLocalReset] = useState(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    }
  }, [])

  const fetchResetStatus = async (signal?: AbortSignal) => {
    const response = await fetch(
      '/api/auth/reset-status',
      signal ? { signal } : undefined,
    )
    const data = await response.json()
    const available = data.resetAvailable === true
    const localSupported = data.localResetSupported === true
    setResetAvailable(available)
    setLocalResetSupported(localSupported)
    return { available, localSupported }
  }

  useEffect(() => {
    const controller = new AbortController()
    fetchResetStatus(controller.signal).catch(() => {
      setResetAvailable(false)
      setLocalResetSupported(false)
    })
    return () => controller.abort()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(username, password, rememberMe)
      setDeviceFailedAttempts(0)
      try {
        localStorage.removeItem(LOGIN_DEVICE_FAILURE_KEY)
      } catch {
        /* ignore */
      }
    } catch (err) {
      setError(rawErrorMessageIntentional(err, 'Login failed'))
      setDeviceFailedAttempts((prev) => {
        const next = prev + 1
        try {
          localStorage.setItem(LOGIN_DEVICE_FAILURE_KEY, String(next))
        } catch {
          /* ignore */
        }
        return next
      })
    } finally {
      setLoading(false)
    }
  }

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setResetSuccess('')
    if (!resetToken || resetToken.trim().length < 8) {
      setError('Reset token must be at least 8 characters')
      return
    }
    if (!newPassword || newPassword.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: resetToken, newPassword }),
        })
      const data = await res.json()
      if (!res.ok)
        throw new ApiError(data.error || 'Reset failed', {
          status: res.status,
          code: data.code,
        })
      setResetSuccess(data.message)
      setResetToken('')
      setNewPassword('')
      setConfirmPassword('')
      setShowRecoveryHelp(false)
      setResetAvailable(false)
      const timer = setTimeout(() => {
        setResetMode(false)
        setResetSuccess('')
      }, 3000)
      resetTimerRef.current = timer
    } catch (err) {
      setError(getUserErrorMessage(err, 'Reset failed'))
    } finally {
      setLoading(false)
    }
  }

  const handleLostPassword = () => {
    setError('')
    setResetSuccess('')
    if (resetAvailable) {
      setShowRecoveryHelp(false)
      setResetMode(true)
      return
    }
    void handleCreateLocalReset()
  }

  const handleRecoveryCheck = async () => {
    setError('')
    setCheckingResetStatus(true)
    try {
      const { available } = await fetchResetStatus()

      if (available) {
        setShowRecoveryHelp(false)
        setResetMode(true)
        return
      }

      setError(
        'No recovery token found yet. Create data/reset-token.txt on the panel host, then try again.',
      )
    } catch {
      setError('Could not check recovery status. Try again in a moment.')
    } finally {
      setCheckingResetStatus(false)
    }
  }

  const handleCreateLocalReset = async () => {
    setError('')
    setResetSuccess('')
    setCreatingLocalReset(true)
    try {
      const res = await fetch('/api/auth/reset-token/local', { method: 'POST' })
      const data = await res.json()
      if (!res.ok)
        throw new ApiError(data.error || 'Could not create a recovery token', {
          status: res.status,
          code: data.code,
        })

      setResetAvailable(true)
      setLocalResetSupported(true)
      setResetToken('')
      setShowRecoveryHelp(false)
      setResetSuccess(
        typeof data.message === 'string'
          ? data.message
          : 'Recovery token created at data/reset-token.txt. Paste it below to continue.',
      )
      setResetMode(true)
    } catch (err) {
      setShowRecoveryHelp(true)
      setError(getUserErrorMessage(err, 'Could not create a recovery token'))
    } finally {
      setCreatingLocalReset(false)
    }
  }

  const busy = loading || checkingResetStatus || creatingLocalReset
  const errorAlert = error && (
    <Alert variant="error" id="login-error" aria-live="assertive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  )

  if (resetMode) {
    return (
      <AuthScreenLayout title="Reset your password" description="Use the recovery token from the panel's computer to choose a new admin password.">
        <form id="login-form" onSubmit={handleReset} className="grid gap-4">
          {errorAlert}
          {resetSuccess && (
            <Alert variant="success" role="status" aria-live="polite">
              <AlertDescription>{resetSuccess}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="resetToken">Recovery token</Label>
            <Input id="resetToken" value={resetToken} onChange={(e) => setResetToken(e.target.value)} placeholder="Paste the token" autoFocus disabled={loading} required minLength={8} maxLength={512} />
            <p className="text-xs text-muted-foreground">It's in data/reset-token.txt on the panel's computer.</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="newPassword">New password</Label>
            <PasswordInput id="newPassword" label="new password" value={newPassword} onChange={setNewPassword} placeholder="At least 6 characters" autoComplete="new-password" disabled={loading} required minLength={6} maxLength={128} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirmPassword">Confirm password</Label>
            <PasswordInput id="confirmPassword" label="password confirmation" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" disabled={loading} required minLength={6} maxLength={128} />
          </div>
          <Button type="submit" disabled={loading}>
            {loading && <Spinner />}
            {loading ? 'Resetting…' : 'Reset password'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setResetMode(false)
              setError('')
              setResetSuccess('')
            }}
          >
            <ArrowLeft />
            Back to sign in
          </Button>
        </form>
      </AuthScreenLayout>
    )
  }

  return (
    <AuthScreenLayout title="Sign in" description="Use your admin account to manage your servers.">
      <form id="login-form" onSubmit={handleSubmit} className="grid gap-4">
        {errorAlert}
        {deviceFailedAttempts >= DEVICE_HINT_THRESHOLD && (
          <Alert role="status">
            <AlertTitle>Still not working?</AlertTitle>
            <AlertDescription>
              After several failed attempts the admin account locks for 15 minutes, and this screen won't say so. Starting the panel with <code>--reset-password</code> from a terminal resets the password without waiting.
            </AlertDescription>
          </Alert>
        )}
        <div className="grid gap-2">
          <Label htmlFor="username">Username</Label>
          <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" autoComplete="username" autoFocus maxLength={32} disabled={loading} aria-describedby={errorId} aria-invalid={error ? true : undefined} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="password">Password</Label>
          <PasswordInput id="password" value={password} onChange={setPassword} autoComplete="current-password" disabled={loading} aria-describedby={errorId} aria-invalid={error ? true : undefined} required maxLength={128} />
        </div>
        <Label className="font-normal text-muted-foreground">
          <Checkbox id="rememberMe" checked={rememberMe} onCheckedChange={(checked) => setRememberMe(checked === true)} />
          Keep me signed in
        </Label>
        <Button type="submit" disabled={loading}>
          {loading && <Spinner />}
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
        <Button type="button" variant="ghost" onClick={handleLostPassword} disabled={busy}>
          {creatingLocalReset ? <Spinner /> : <KeyRound />}
          {creatingLocalReset ? 'Preparing recovery…' : resetAvailable ? 'Use recovery token' : localResetSupported ? 'Create recovery file' : 'Recover account'}
        </Button>
        {showRecoveryHelp && !resetAvailable && (
          <Alert>
            <AlertTitle>Account recovery</AlertTitle>
            <AlertDescription className="grid gap-3">
              {localResetSupported ? (
                <p>This browser runs on the panel's computer. Create a recovery file, then use its token to reset the admin password.</p>
              ) : (
                <p>
                  Create data/reset-token.txt on the panel's computer with any token of 8 characters or more. You can also start the panel with <code>--reset-password</code> from a terminal.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {localResetSupported ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => void handleCreateLocalReset()} disabled={busy}>
                    {creatingLocalReset && <Spinner />}
                    {creatingLocalReset ? 'Preparing…' : 'Create file'}
                  </Button>
                ) : (
                  <Button type="button" size="sm" variant="outline" onClick={handleRecoveryCheck} disabled={checkingResetStatus || loading}>
                    {checkingResetStatus && <Spinner />}
                    {checkingResetStatus ? 'Checking…' : 'Check token'}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowRecoveryHelp(false)
                    setError('')
                  }}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
      </form>
    </AuthScreenLayout>
  )
}
