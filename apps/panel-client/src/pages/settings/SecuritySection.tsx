import { useEffect, useState, type FormEvent } from 'react'
import { KeyRound, Loader2, RefreshCw } from 'lucide-react'
import { authApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useAuth } from '@/contexts/AuthContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { SettingsCard, SettingsRow } from '@/components/settings-layout'
import { PasswordInput } from '@/components/PasswordInput'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toastManager } from '@/components/ui/toast'

const MIN_PASSWORD = 6

function passwordProblem(password: string, confirm: string): string | null {
  if (password && password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`
  if (password && confirm && password !== confirm) return "The passwords don't match."
  return null
}

function ChangePassword() {
  const { user } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const problem = passwordProblem(next, confirm)
  const ready = current && next && confirm && !problem

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    try {
      await authApi.changePassword(current, next)
      toastManager.add({ title: 'Password changed', type: 'success' })
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch (error) {
      toastManager.add({
        title: "Couldn't change the password",
        description: getUserErrorMessage(error, 'Check your current password and try again.'),
        type: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid max-w-sm gap-3 py-4">
      <input type="text" name="username" value={user?.username || ''} autoComplete="username" readOnly hidden />
      <PasswordInput value={current} onChange={setCurrent} placeholder="Current password" label="current password" autoComplete="current-password" maxLength={128} />
      <PasswordInput value={next} onChange={setNext} placeholder="New password" label="new password" autoComplete="new-password" maxLength={128} />
      <PasswordInput value={confirm} onChange={setConfirm} placeholder="Confirm new password" label="new password confirmation" autoComplete="new-password" maxLength={128} />
      {problem && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {problem}
        </p>
      )}
      <Button type="submit" disabled={!ready || busy} className="justify-self-start">
        {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
        {busy ? 'Changing…' : 'Change password'}
      </Button>
    </form>
  )
}

function LocalRecovery() {
  const { logout } = useAuth()
  const [supported, setSupported] = useState(false)
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [resetting, setResetting] = useState(false)
  const problem = passwordProblem(password, confirm)

  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/reset-status')
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setSupported(data.localResetSupported === true)
      })
      .catch(() => {
        if (!cancelled) setSupported(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const prepare = async () => {
    setPreparing(true)
    try {
      const response = await fetch('/api/auth/reset-token/local', { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "The panel couldn't prepare recovery on this server.")
      setSupported(true)
      setOpen(true)
      setToken('')
      toastManager.add({
        title: 'Recovery ready',
        description: typeof data.message === 'string' ? data.message : 'A recovery token was written to data/reset-token.txt. Paste it below.',
      })
    } catch (error) {
      toastManager.add({ title: 'Recovery unavailable', description: getUserErrorMessage(error, "The panel couldn't prepare recovery on this server."), type: 'error' })
    } finally {
      setPreparing(false)
    }
  }

  const reset = async (event: FormEvent) => {
    event.preventDefault()
    if (!token || !password || !confirm || problem || resetting) return
    setResetting(true)
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "The panel couldn't reset your password.")
      toastManager.add({ title: 'Password reset', description: 'Sign in again with the new password.' })
      await logout()
    } catch (error) {
      toastManager.add({ title: "Couldn't reset the password", description: getUserErrorMessage(error, "The panel couldn't reset your password."), type: 'error' })
    } finally {
      setResetting(false)
    }
  }

  if (!supported) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        The panel can't show existing passwords. If you can reach the panel host's files, sign out and either create{' '}
        <code className="font-mono">data/reset-token.txt</code> or start the panel with <code className="font-mono">--reset-password</code>. The sign-in
        screen then offers a recovery option.
      </p>
    )
  }

  return (
    <div className="grid gap-3 py-4">
      <p className="text-sm text-muted-foreground">This session runs on the panel host, so you can reset the password here without the current one.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void prepare()} disabled={preparing || resetting}>
          {preparing ? <Loader2 className="animate-spin" /> : <KeyRound />}
          {open ? 'Make a new recovery token' : 'Reset the password on this server'}
        </Button>
        {open && (
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={preparing || resetting}>
            Hide
          </Button>
        )}
      </div>
      {open && (
        <form onSubmit={(e) => void reset(e)} className="grid max-w-sm gap-3">
          <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Token from data/reset-token.txt" autoComplete="off" aria-label="Recovery token" />
          <PasswordInput value={password} onChange={setPassword} placeholder="New password" label="new password" autoComplete="new-password" maxLength={128} />
          <PasswordInput value={confirm} onChange={setConfirm} placeholder="Confirm new password" label="new password confirmation" autoComplete="new-password" maxLength={128} />
          {problem && (
            <p role="alert" className="text-sm text-destructive-foreground">
              {problem}
            </p>
          )}
          <Button type="submit" disabled={!token || !password || !confirm || Boolean(problem) || resetting || preparing} className="justify-self-start">
            {resetting ? <Loader2 className="animate-spin" /> : <KeyRound />}
            {resetting ? 'Resetting…' : 'Reset password and sign out'}
          </Button>
        </form>
      )}
    </div>
  )
}

function RegenerateJwtSecret() {
  const { logout } = useAuth()
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)

  const regenerate = async () => {
    const ok = await confirm({
      title: 'Sign out everyone?',
      description:
        'This replaces the signing secret, which signs out every user on every device right now, including you. You will need to sign in again. It cannot be undone.',
      confirmLabel: 'Sign out everyone',
    })
    if (!ok) return
    setBusy(true)
    try {
      await authApi.regenerateJwtSecret()
      toastManager.add({ title: 'Signing secret replaced', description: 'Every session was signed out. Taking you to sign-in…' })
      await logout()
    } catch (error) {
      toastManager.add({ title: "Couldn't replace the secret", description: getUserErrorMessage(error, "The panel couldn't regenerate the JWT secret."), type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button variant="destructive-outline" onClick={() => void regenerate()} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      Regenerate secret
    </Button>
  )
}

export function SecuritySection() {
  const { user, authEnabled } = useAuth()

  if (!authEnabled) {
    return (
      <Alert variant="warning">
        <AlertTitle>Sign-in is off</AlertTitle>
        <AlertDescription>Anyone who can open this panel can control your servers. Create an account through the first-run setup to protect it.</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="grid gap-4">
      <SettingsCard title="Password" description={user ? `Signed in as ${user.username}.` : undefined}>
        <ChangePassword />
      </SettingsCard>
      <SettingsCard title="Lost password">
        <LocalRecovery />
      </SettingsCard>
      {user && (
        <SettingsCard title="Sessions">
          <SettingsRow
            label="Regenerate the JWT signing secret"
            description="Signs out every user on every device at once. Use it only if a backup holding the old key may have leaked. There is no automatic rotation."
          >
            <RegenerateJwtSecret />
          </SettingsRow>
        </SettingsCard>
      )}
    </div>
  )
}
