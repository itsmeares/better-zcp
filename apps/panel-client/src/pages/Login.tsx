import { useQuery } from '@tanstack/react-query'
import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import {
  rawErrorMessageIntentional,
  getUserErrorMessage,
} from '../lib/errorMessage'
import { ApiError } from '../lib/ApiError'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Checkbox } from '../components/ui/checkbox'
import { panelHealthQueryOptions } from '../lib/panelHealth'
import { Eye, EyeOff, Loader2, ArrowLeft, KeyRound } from 'lucide-react'

type PanelStatus = 'checking' | 'online' | 'unreachable'

const LOGIN_DEVICE_FAILURE_KEY = 'pz-login-failed-attempts'
const DEVICE_HINT_THRESHOLD = 3

function readDeviceFailureCount(): number {
  try {
    return Number(localStorage.getItem(LOGIN_DEVICE_FAILURE_KEY)) || 0
  } catch {
    return 0
  }
}

function usePanelHealth() {
  const { data, isPending, isError } = useQuery({
    ...panelHealthQueryOptions(),
    refetchInterval: 15000,
  })
  return {
    status: (isPending
      ? 'checking'
      : isError
        ? 'unreachable'
        : 'online') as PanelStatus,
    version: data?.version ?? null,
  }
}

export default function Login() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
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
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [localResetSupported, setLocalResetSupported] = useState(false)
  const [showRecoveryHelp, setShowRecoveryHelp] = useState(false)
  const [checkingResetStatus, setCheckingResetStatus] = useState(false)
  const [creatingLocalReset, setCreatingLocalReset] = useState(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { status, version } = usePanelHealth()

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

  const statusMap: Record<
    PanelStatus,
    { label: string; tone: string; dot: string }
  > = {
    checking: {
      label: 'Checking',
      tone: 'text-muted-foreground',
      dot: 'bg-muted-foreground/60',
    },
    online: { label: 'Online', tone: 'text-success', dot: 'bg-success' },
    unreachable: {
      label: 'Offline',
      tone: 'text-destructive',
      dot: 'bg-destructive',
    },
  }
  const s = statusMap[status]

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <a
        href="#login-form"
        className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        {'Skip to form'}
      </a>

      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,hsl(var(--primary)/0.10),transparent_34rem),linear-gradient(180deg,hsl(var(--background)),hsl(24_8%_4%))]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-border/70"
      />

      <header className="relative mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 text-sm sm:px-8">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {'Project Zomboid Control Panel'}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {'Admin access'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
            <span className={s.tone}>{s.label}</span>
            {version && (
              <span className="hidden text-muted-foreground/70 sm:inline">
                v{version}
              </span>
            )}
          </span>
        </div>
      </header>

      <main className="relative mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-6xl items-center justify-center px-5 pb-12 pt-4 sm:px-8">
        <section
          className="w-full max-w-[420px] rounded-lg border border-border/70 bg-card/90 p-6 shadow-[0_24px_80px_-48px_hsl(var(--foreground)/0.45)] sm:p-7"
          aria-labelledby="login-title"
        >
          <div className="mb-6 space-y-2">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              {resetMode ? 'Account recovery' : 'Secure sign in'}
            </p>
            <h1
              id="login-title"
              className="text-2xl font-semibold tracking-normal text-foreground"
            >
              {resetMode ? 'Reset your password' : 'Sign in'}
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              {resetMode
                ? 'Use the recovery token from the panel host to choose a new admin password.'
                : 'Use your admin account to manage this server.'}
            </p>
          </div>

          {resetMode ? (
            <form id="login-form" onSubmit={handleReset} className="space-y-4">
              {error && (
                <div
                  role="alert"
                  aria-live="assertive"
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {error}
                </div>
              )}
              {resetSuccess && (
                <div
                  role="status"
                  aria-live="polite"
                  className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"
                >
                  {resetSuccess}
                </div>
              )}

              <div className="space-y-1.5">
                <Label
                  htmlFor="resetToken"
                  className="text-sm font-medium text-foreground"
                >
                  {'Recovery token'}
                </Label>
                <Input
                  id="resetToken"
                  type="text"
                  value={resetToken}
                  onChange={(e) => setResetToken(e.target.value)}
                  placeholder="Paste token"
                  autoFocus
                  disabled={loading}
                  required
                  minLength={8}
                  maxLength={512}
                  className="text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  {'Stored at data/reset-token.txt on the panel host.'}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label
                  htmlFor="newPassword"
                  className="text-sm font-medium text-foreground"
                >
                  {'New password'}
                </Label>
                <div className="relative">
                  <Input
                    id="newPassword"
                    type={showNewPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={'Minimum 6 characters'}
                    className="pe-10 text-sm"
                    disabled={loading}
                    required
                    minLength={6}
                    maxLength={128}
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    className="absolute inset-y-0 end-3 flex items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    title={showNewPassword ? 'Hide password' : 'Show password'}
                    aria-label={
                      showNewPassword ? 'Hide password' : 'Show password'
                    }
                    aria-pressed={showNewPassword}
                  >
                    {showNewPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label
                  htmlFor="confirmPassword"
                  className="text-sm font-medium text-foreground"
                >
                  {'Confirm password'}
                </Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder={'Repeat new password'}
                  disabled={loading}
                  required
                  minLength={6}
                  maxLength={128}
                  className="text-sm"
                />
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> {'Resetting…'}
                  </>
                ) : (
                  'Reset password'
                )}
              </Button>

              <Button
                type="button"
                variant="ghost"
                className="w-full text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setResetMode(false)
                  setError('')
                  setResetSuccess('')
                }}
              >
                <ArrowLeft className="me-1.5 h-4 w-4" />
                {'Back to sign in'}
              </Button>
            </form>
          ) : (
            <>
              <form
                id="login-form"
                onSubmit={handleSubmit}
                className="space-y-4"
              >
                {error && (
                  <div
                    id="login-error"
                    role="alert"
                    aria-live="assertive"
                    className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    {error}
                  </div>
                )}

                {deviceFailedAttempts >= DEVICE_HINT_THRESHOLD && (
                  <div
                    role="status"
                    className="rounded-md border border-border/70 bg-muted/20 px-3 py-2.5 text-xs leading-5 text-muted-foreground"
                  >
                    <p className="font-medium text-foreground">
                      {'Still not working?'}
                    </p>
                    <p className="mt-1">
                      <>
                        {
                          'After several failed attempts, the admin account locks automatically for 15 minutes as a security precaution -- this screen will not say so. Starting the panel with '
                        }
                        {'--reset-password'}
                        {
                          ' from the server terminal, can reset the password without waiting.'
                        }
                      </>
                    </p>
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label
                    htmlFor="username"
                    className="text-sm font-medium text-foreground"
                  >
                    {'Username'}
                  </Label>
                  <Input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin"
                    autoComplete="username"
                    autoFocus
                    maxLength={32}
                    disabled={loading}
                    aria-describedby={errorId}
                    aria-invalid={error ? true : undefined}
                    required
                    className="text-sm"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label
                    htmlFor="password"
                    className="text-sm font-medium text-foreground"
                  >
                    {'Password'}
                  </Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={'Password'}
                      autoComplete="current-password"
                      className="pe-10 text-sm"
                      disabled={loading}
                      aria-describedby={errorId}
                      aria-invalid={error ? true : undefined}
                      required
                      maxLength={128}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute inset-y-0 end-3 flex items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      title={showPassword ? 'Hide password' : 'Show password'}
                      aria-label={
                        showPassword ? 'Hide password' : 'Show password'
                      }
                      aria-pressed={showPassword}
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-0.5">
                  <Checkbox
                    id="rememberMe"
                    checked={rememberMe}
                    onCheckedChange={(checked) =>
                      setRememberMe(checked === true)
                    }
                  />
                  <Label
                    htmlFor="rememberMe"
                    className="cursor-pointer text-sm font-normal text-muted-foreground"
                  >
                    {'Keep me signed in'}
                  </Label>
                </div>

                <div className="space-y-2 pt-1">
                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />{' '}
                        {'Signing in…'}
                      </>
                    ) : (
                      'Sign in'
                    )}
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full text-muted-foreground hover:text-foreground"
                    onClick={handleLostPassword}
                    disabled={
                      loading || checkingResetStatus || creatingLocalReset
                    }
                  >
                    {creatingLocalReset ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <KeyRound className="h-4 w-4" />
                    )}
                    {creatingLocalReset
                      ? 'Preparing recovery…'
                      : resetAvailable
                        ? 'Use recovery token'
                        : localResetSupported
                          ? 'Create recovery file'
                          : 'Recover account'}
                  </Button>
                </div>

                {showRecoveryHelp && !resetAvailable && (
                  <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
                    <p className="font-medium text-foreground">
                      {'Account recovery'}
                    </p>
                    {localResetSupported ? (
                      <p className="mt-2 leading-6">
                        {
                          'This browser is running on the panel host. Create a recovery file, then use its token to reset the admin password.'
                        }
                      </p>
                    ) : (
                      <>
                        <p className="mt-2 leading-6">
                          {
                            'Create data/reset-token.txt on the panel host with any token at least 8 characters long.'
                          }
                        </p>
                        <p className="mt-2 leading-6">
                          <>
                            {'You can also start the panel with '}
                            {'--reset-password'}
                            {' from the server terminal.'}
                          </>
                        </p>
                      </>
                    )}
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      {localResetSupported ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="sm:flex-1"
                          onClick={() => void handleCreateLocalReset()}
                          disabled={
                            creatingLocalReset || checkingResetStatus || loading
                          }
                        >
                          {creatingLocalReset ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin" />{' '}
                              {'Preparing…'}
                            </>
                          ) : (
                            'Create file'
                          )}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          className="sm:flex-1"
                          onClick={handleRecoveryCheck}
                          disabled={checkingResetStatus || loading}
                        >
                          {checkingResetStatus ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin" />{' '}
                              {'Checking…'}
                            </>
                          ) : (
                            'Check token'
                          )}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        className="sm:flex-1"
                        onClick={() => {
                          setShowRecoveryHelp(false)
                          setError('')
                        }}
                        disabled={
                          creatingLocalReset || checkingResetStatus || loading
                        }
                      >
                        {'Cancel'}
                      </Button>
                    </div>
                  </div>
                )}
              </form>
            </>
          )}
        </section>
      </main>
    </div>
  )
}
