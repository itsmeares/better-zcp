import { Link, Outlet, useLocation } from '@/lib/routerCompat'
import { useEffect, useState, useCallback, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { DirectionProvider } from '@radix-ui/react-direction'
import type { Socket } from 'socket.io-client'
import Layout from './components/Layout'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Toaster } from './components/ui/toaster'
import { SocketContext, ConnectionStatus, ConnectionStatusContext } from './contexts/SocketContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ConfirmProvider } from './contexts/ConfirmContext'
import { TooltipProvider } from './components/ui/tooltip'
import { useToast } from './components/ui/use-toast'
import { PageSkeleton } from './components/PageSkeleton'
import { ScrollToTop } from './components/ScrollToTop'
import { isDemoMode } from './lib/demo'
import { getUserErrorMessage } from './lib/errorMessage'
import { createSocketAuthProvider } from './lib/socketAuth'
import { registerReconnectRecovery } from './lib/socketRecovery'
import { isRTL } from './i18n'

type RouteLoaderMeta = {
  title: string
  description: string
  eyebrow: string
  variant: 'dashboard' | 'list' | 'form' | 'console' | 'map' | 'default'
  metrics: string[]
}

const ROUTE_LOADERS: Record<string, RouteLoaderMeta> = {
  '/': {
    title: 'Dashboard',
    description: 'Loading live server state, players, actions, and maintenance telemetry.',
    eyebrow: '// LIVE · OVERVIEW',
    variant: 'dashboard',
    metrics: ['status', 'players', 'rcon'],
  },
  '/players': {
    title: 'Online Players',
    description: 'Preparing player rows, admin actions, notes, and session details.',
    eyebrow: '// LIVE · PLAYERS',
    variant: 'list',
    metrics: ['roster', 'actions', 'notes'],
  },
  '/console': {
    title: 'Server Console',
    description: 'Opening command history, RCON state, and live output stream.',
    eyebrow: '// LIVE · CONSOLE',
    variant: 'console',
    metrics: ['rcon', 'history', 'stream'],
  },
  '/chat': {
    title: 'In-Game Chat',
    description: 'Loading bridge chat channels and recent server messages.',
    eyebrow: '// LIVE · CHAT',
    variant: 'console',
    metrics: ['bridge', 'messages', 'send'],
  },
  '/events': {
    title: 'Events & Weather',
    description: 'Preparing world controls, weather overrides, and event triggers.',
    eyebrow: '// WORLD · CONTROL',
    variant: 'form',
    metrics: ['weather', 'time', 'events'],
  },
  '/world-map': {
    title: 'World Map',
    description: 'Loading map tiles, marker tools, and player/world overlays.',
    eyebrow: '// WORLD · MAP',
    variant: 'map',
    metrics: ['tiles', 'markers', 'layers'],
  },
  '/server-config': {
    title: 'Server Configuration',
    description: 'Loading INI sections, validation, and server-safe edit controls.',
    eyebrow: '// CONFIG · INI',
    variant: 'form',
    metrics: ['ini', 'validate', 'save'],
  },
  '/mods': {
    title: 'Mod Manager',
    description: 'Loading Workshop status, active mod IDs, conflicts, and update state.',
    eyebrow: '// CONFIG · WORKSHOP',
    variant: 'list',
    metrics: ['workshop', 'mods', 'conflicts'],
  },
  '/templates': {
    title: 'Simulation Templates',
    description: 'Loading rulesets, diff previews, and apply controls.',
    eyebrow: '// CONFIG · TEMPLATES',
    variant: 'list',
    metrics: ['templates', 'diff', 'apply'],
  },
  '/scheduler': {
    title: 'Scheduled Tasks',
    description: 'Preparing task rules, run history, and automation controls.',
    eyebrow: '// MAINTAIN · SCHEDULE',
    variant: 'list',
    metrics: ['tasks', 'history', 'cron'],
  },
  '/backups': {
    title: 'World Backups',
    description: 'Loading backup inventory, restore controls, and storage status.',
    eyebrow: '// MAINTAIN · BACKUPS',
    variant: 'list',
    metrics: ['files', 'storage', 'restore'],
  },
  '/chunks': {
    title: 'Map Cleanup',
    description: 'Preparing chunk previews, safety checks, and cleanup tools.',
    eyebrow: '// MAINTAIN · MAP DATA',
    variant: 'map',
    metrics: ['chunks', 'preview', 'safe'],
  },
  '/servers': {
    title: 'My Servers',
    description: 'Loading server profiles, active target, and connection details.',
    eyebrow: '// SERVERS · PROFILES',
    variant: 'list',
    metrics: ['profiles', 'active', 'paths'],
  },
  '/server-setup': {
    title: 'Server Setup',
    description: 'Preparing install choices, paths, ports, and launch checks.',
    eyebrow: '// SERVERS · SETUP',
    variant: 'form',
    metrics: ['install', 'ports', 'start'],
  },
  '/server-finder': {
    title: 'Browse Public Servers',
    description: 'Loading discovery filters, search results, and server details.',
    eyebrow: '// SERVERS · DISCOVERY',
    variant: 'list',
    metrics: ['search', 'filters', 'results'],
  },
  '/discord': {
    title: 'Discord Integration',
    description: 'Loading bot status, channel wiring, and message controls.',
    eyebrow: '// SYSTEM · DISCORD',
    variant: 'form',
    metrics: ['bot', 'channels', 'alerts'],
  },
  '/settings': {
    title: 'Panel Settings',
    description: 'Loading access, paths, network, and panel preference controls.',
    eyebrow: '// SYSTEM · SETTINGS',
    variant: 'form',
    metrics: ['auth', 'paths', 'network'],
  },
  '/debug': {
    title: 'Debug Logs',
    description: 'Preparing diagnostics, probes, logs, and support bundle tools.',
    eyebrow: '// SYSTEM · DIAGNOSTICS',
    variant: 'console',
    metrics: ['logs', 'probes', 'bundle'],
  },
}

const AUTH_BOOT_STEPS = [
  { code: 'AUTH', label: 'Verifying credentials' },
  { code: 'LINK', label: 'Opening control channel' },
  { code: 'SYNC', label: 'Restoring panel state' },
  { code: 'NET ', label: 'Pinging live servers' },
  { code: 'OK  ', label: 'Standing by' },
]

const Login = lazy(() => import('./pages/Login'))
const Setup = lazy(() => import('./pages/Setup'))

function PageLoader() {
  const { pathname } = useLocation()
  const meta = ROUTE_LOADERS[pathname] || ROUTE_LOADERS['/']
  return <PageSkeleton {...meta} />
}

function AuthScreenLoader() {
  const [stepIndex, setStepIndex] = useState(0)
  const [tick, setTick] = useState(0)
  const totalSteps = AUTH_BOOT_STEPS.length

  useEffect(() => {
    const stepTimer = window.setInterval(() => {
      setStepIndex((current) => Math.min(current + 1, totalSteps - 1))
    }, 350)
    const tickTimer = window.setInterval(() => {
      setTick((current) => (current + 1) % 4)
    }, 500)
    return () => {
      window.clearInterval(stepTimer)
      window.clearInterval(tickTimer)
    }
  }, [totalSteps])

  const now = new Date()
  const clock = now.toISOString().slice(11, 19)
  const dots = '·'.repeat(tick) + ' '.repeat(3 - tick)
  const progress = Math.round(((stepIndex + 1) / totalSteps) * 100)
  const segments = 24
  const lit = Math.round((segments * (stepIndex + 1)) / totalSteps)

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-6 py-10">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(ellipse at 50% 30%, hsl(var(--primary) / 0.10), transparent 55%), radial-gradient(circle at 12% 110%, hsl(var(--destructive) / 0.10), transparent 45%), linear-gradient(180deg, hsl(var(--background)), hsl(var(--background)))',
        }}
      />
      <div aria-hidden="true" className="control-room-sweep absolute inset-0 opacity-40" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ boxShadow: 'inset 0 0 220px 40px hsl(var(--background))' }}
      />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-5 py-3 font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/70">
        <span>Project Zomboid // Control Panel</span>
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400/80 shadow-[0_0_8px_hsl(var(--primary)/0.6)]" />
          <span>Secure Handshake</span>
        </span>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between px-5 py-3 font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/60">
        <span>{clock} UTC</span>
        <span>STAND BY{dots}</span>
        <span>{progress.toString().padStart(3, '0')}%</span>
      </div>

      <div className="relative w-full max-w-[520px]">
        <span aria-hidden="true" className="pointer-events-none absolute -start-2 -top-2 h-5 w-5 border-s-2 border-t-2 border-primary/45" />
        <span aria-hidden="true" className="pointer-events-none absolute -end-2 -top-2 h-5 w-5 border-e-2 border-t-2 border-primary/45" />
        <span aria-hidden="true" className="pointer-events-none absolute -bottom-2 -start-2 h-5 w-5 border-b-2 border-s-2 border-primary/45" />
        <span aria-hidden="true" className="pointer-events-none absolute -bottom-2 -end-2 h-5 w-5 border-b-2 border-e-2 border-primary/45" />

        <div className="relative rounded-md border border-border/60 bg-card/70 px-6 py-7 backdrop-blur-sm shadow-[0_30px_80px_-50px_hsl(var(--foreground)/0.6)]">
          <div className="mb-5 flex items-center justify-between border-b border-border/50 pb-3 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            <span className="text-primary/80">// boot.sequence</span>
            <span>node · admin</span>
          </div>

          <div className="flex items-center gap-5">
            <div className="relative shrink-0">
              <img
                src={`${import.meta.env.BASE_URL}spiffo.png`}
                alt=""
                aria-hidden="true"
                className="h-16 w-16 select-none drop-shadow-[0_0_18px_hsl(var(--primary)/0.35)]"
                style={{ imageRendering: 'pixelated' }}
                draggable={false}
              />
              <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400 ring-2 ring-card" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/70">
                Establishing session
              </div>
              <div className="mt-1 truncate font-mono text-base font-semibold tracking-[0.18em] text-foreground">
                CONTROL ROOM ONLINE
              </div>
            </div>
          </div>

          <ul className="mt-6 space-y-1.5 font-mono text-[11px] leading-tight" aria-live="polite">
            {AUTH_BOOT_STEPS.map((step, idx) => {
              const isDone = idx < stepIndex
              const isCurrent = idx === stepIndex
              const isPending = idx > stepIndex
              return (
                <li
                  key={step.code}
                  className={`flex items-center gap-3 transition-colors ${
                    isPending ? 'text-muted-foreground/35' : 'text-foreground/85'
                  }`}
                >
                  <span
                    className={`inline-flex h-4 w-4 items-center justify-center rounded-[3px] border text-[8px] font-semibold ${
                      isDone
                        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400'
                        : isCurrent
                          ? 'border-primary/60 bg-primary/15 text-primary animate-pulse'
                          : 'border-border/50 bg-transparent text-muted-foreground/50'
                    }`}
                  >
                    {isDone ? '✓' : isCurrent ? '›' : '·'}
                  </span>
                  <span className="w-10 shrink-0 uppercase tracking-[0.18em] text-muted-foreground/70">
                    {step.code}
                  </span>
                  <span className="truncate">{step.label}</span>
                  {isCurrent && (
                    <span className="ms-auto text-[10px] uppercase tracking-[0.2em] text-primary/80">
                      …
                    </span>
                  )}
                  {isDone && (
                    <span className="ms-auto text-[10px] uppercase tracking-[0.2em] text-emerald-500/70">
                      OK
                    </span>
                  )}
                </li>
              )
            })}
          </ul>

          <div className="mt-6 flex items-center gap-[3px]" aria-hidden="true">
            {Array.from({ length: segments }).map((_, idx) => (
              <span
                key={idx}
                className={`h-1.5 flex-1 rounded-[1px] transition-colors duration-300 ${
                  idx < lit
                    ? idx === lit - 1
                      ? 'bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]'
                      : 'bg-primary/70'
                    : 'bg-border/40'
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function NotFoundRoute() {
  return (
    <div className="space-y-6 page-transition">
      <div className="rounded-xl border border-border/70 bg-card/70 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Page Not Found</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          The route you requested does not exist or is no longer available in this panel build.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Link to="/" className="inline-flex min-h-10 items-center rounded-md border border-border/70 bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Go to Dashboard
          </Link>
          <Link to="/servers" className="inline-flex min-h-10 items-center rounded-md border border-border/70 bg-background px-4 text-sm font-medium hover:bg-muted/50">
            Open Servers
          </Link>
        </div>
      </div>
    </div>
  )
}

function AppContent() {
  const demoMode = isDemoMode()
  const [socket, setSocket] = useState<Socket | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false,
    reconnecting: false,
    reconnectAttempt: 0,
    error: null,
  })
  const { toast } = useToast()
  const { isAuthenticated, isLoading, needsSetup, authEnabled, getToken } = useAuth()

  const handleReconnectSuccess = useCallback(() => {
    toast({
      title: 'Reconnected',
      description: 'Connection to server restored',
      variant: 'success' as const,
    })
  }, [toast])

  useEffect(() => {
    if (demoMode) return
    if (isLoading) return
    if (authEnabled && !isAuthenticated && !needsSetup) return

    let cancelled = false
    let createdSocket: Socket | null = null
    let disposeRecovery: (() => void) | null = null

    const setupSocket = async () => {
      const { io } = await import('socket.io-client')
      if (cancelled) return

      const newSocket = io(window.location.origin, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        autoConnect: false,
      })
      createdSocket = newSocket
      newSocket.auth = createSocketAuthProvider(getToken)
      newSocket.connect()

      newSocket.on('connect', () => {
        disposeRecovery?.()
        disposeRecovery = null
        setConnectionStatus(prev => {
          if (prev.reconnecting || prev.reconnectAttempt > 0) {
            handleReconnectSuccess()
          }
          return {
            connected: true,
            reconnecting: false,
            reconnectAttempt: 0,
            error: null,
          }
        })
        newSocket.emit('subscribe:status')
        newSocket.emit('subscribe:players')
        newSocket.emit('subscribe:logs')
      })

      newSocket.on('disconnect', (reason) => {
        setConnectionStatus(prev => ({
          ...prev,
          connected: false,
          error: reason === 'io server disconnect' ? 'Server closed connection' : null,
        }))
      })

      newSocket.on('connect_error', (err) => {
        if (newSocket.active) {
          setConnectionStatus(prev => ({
            ...prev,
            connected: false,
            reconnecting: true,
            error: getUserErrorMessage(err, 'Connection error'),
          }))
        } else {
          setConnectionStatus({
            connected: false,
            reconnecting: false,
            reconnectAttempt: 0,
            error: getUserErrorMessage(err, 'Connection error'),
          })
        }
      })

      newSocket.io.on('reconnect_attempt', (attempt) => {
        setConnectionStatus(prev => ({
          ...prev,
          reconnecting: true,
          reconnectAttempt: attempt,
        }))
      })

      newSocket.io.on('reconnect_failed', () => {
        setConnectionStatus({
          connected: false,
          reconnecting: false,
          reconnectAttempt: 0,
          error: 'Failed to reconnect after multiple attempts',
        })
        toast({
          title: 'Connection Lost',
          description: 'Unable to reconnect automatically. Reconnecting once this tab is visible or your network is back — or use Retry in the connection status indicator.',
          variant: 'destructive',
        })

        disposeRecovery?.()
        disposeRecovery = registerReconnectRecovery(() => newSocket.connect())
      })

      setSocket(newSocket)
    }

    void setupSocket()

    return () => {
      cancelled = true
      disposeRecovery?.()
      createdSocket?.close()
    }
  }, [toast, handleReconnectSuccess, isLoading, isAuthenticated, authEnabled, needsSetup, getToken, demoMode])

  if (isLoading) {
    return <AuthScreenLoader />
  }

  if (needsSetup) {
    return (
      <Suspense fallback={<AuthScreenLoader />}>
        <>
          <Setup />
          <Toaster />
        </>
      </Suspense>
    )
  }

  if (authEnabled && !isAuthenticated) {
    return (
      <Suspense fallback={<AuthScreenLoader />}>
        <>
          <Login />
          <Toaster />
        </>
      </Suspense>
    )
  }

  return (
    <ConnectionStatusContext.Provider value={connectionStatus}>
      <SocketContext.Provider value={socket}>
        <Layout>
          <ScrollToTop />
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </Layout>
        <Toaster />
      </SocketContext.Provider>
    </ConnectionStatusContext.Provider>
  )
}

function App() {
  const { i18n } = useTranslation()
  return (
    <ErrorBoundary>
      <DirectionProvider dir={isRTL(i18n.language) ? 'rtl' : 'ltr'}>
        <ThemeProvider>
          <TooltipProvider>
            <AuthProvider>
              <ConfirmProvider>
                <AppContent />
              </ConfirmProvider>
            </AuthProvider>
          </TooltipProvider>
        </ThemeProvider>
      </DirectionProvider>
    </ErrorBoundary>
  )
}

export default App
