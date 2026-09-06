import { Routes, Route, Link, Navigate, useLocation } from 'react-router-dom'
import { useEffect, useState, useCallback, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { DirectionProvider } from '@radix-ui/react-direction'
import type { Socket } from 'socket.io-client'
import Layout from './components/Layout'
import { ErrorBoundary } from './components/ErrorBoundary'
import {
  FeatureErrorBoundary,
} from './components/FeatureErrorBoundary'
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

// Lazy load larger pages for code splitting
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Players = lazy(() => import('./pages/Players'))
const Console = lazy(() => import('./pages/Console'))
const Scheduler = lazy(() => import('./pages/Scheduler'))
const Mods = lazy(() => import('./pages/Mods'))
const ChunkCleaner = lazy(() => import('./pages/ChunkCleaner'))
const Discord = lazy(() => import('./pages/Discord'))
const Settings = lazy(() => import('./pages/Settings'))
const ServerSetup = lazy(() => import('./pages/ServerSetup'))
const Servers = lazy(() => import('./pages/Servers'))
const ServerConfig = lazy(() => import('./pages/ServerConfig'))
const Templates = lazy(() => import('./pages/Templates'))
const Debug = lazy(() => import('./pages/Debug'))
const ServerFinder = lazy(() => import('./pages/ServerFinder'))
const Events = lazy(() => import('./pages/Events'))
const Chat = lazy(() => import('./pages/Chat'))
const Backups = lazy(() => import('./pages/Backups'))
const WorldMap = lazy(() => import('./pages/WorldMap'))
const Login = lazy(() => import('./pages/Login'))
const Setup = lazy(() => import('./pages/Setup'))

// Loading fallback — shows a skeleton layout instead of a plain spinner
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
    // Advances every 350ms (was 650ms) so the full sequence takes ~1.75s
    // instead of ~3.25s for 5 steps — this animation doesn't gate anything
    // (the parent swaps it out the instant real auth resolves), but a
    // shorter total duration means less of it is ever visibly cut off
    // mid-step on a fast resolution, and less of a screen seen many times a
    // day feels like padded theater.
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
  // Real UTC, not local time — this used to be toTimeString() (LOCAL time)
  // mislabeled "UTC" below.
  const clock = now.toISOString().slice(11, 19)
  const dots = '·'.repeat(tick) + ' '.repeat(3 - tick)
  const progress = Math.round(((stepIndex + 1) / totalSteps) * 100)
  const segments = 24
  const lit = Math.round((segments * (stepIndex + 1)) / totalSteps)

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-6 py-10">
      {/* Atmospheric backdrop */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(ellipse at 50% 30%, hsl(var(--primary) / 0.10), transparent 55%), radial-gradient(circle at 12% 110%, hsl(var(--destructive) / 0.10), transparent 45%), linear-gradient(180deg, hsl(var(--background)), hsl(var(--background)))',
        }}
      />
      <div aria-hidden="true" className="control-room-sweep absolute inset-0 opacity-40" />
      {/* Vignette */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ boxShadow: 'inset 0 0 220px 40px hsl(var(--background))' }}
      />

      {/* Top status bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-5 py-3 font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/70">
        <span>Project Zomboid // Control Panel</span>
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400/80 shadow-[0_0_8px_hsl(var(--primary)/0.6)]" />
          <span>Secure Handshake</span>
        </span>
      </div>

      {/* Bottom status bar */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between px-5 py-3 font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/60">
        <span>{clock} UTC</span>
        <span>STAND BY{dots}</span>
        <span>{progress.toString().padStart(3, '0')}%</span>
      </div>

      {/* Center stage */}
      <div className="relative w-full max-w-[520px]">
        {/* Corner brackets */}
        <span aria-hidden="true" className="pointer-events-none absolute -start-2 -top-2 h-5 w-5 border-s-2 border-t-2 border-primary/45" />
        <span aria-hidden="true" className="pointer-events-none absolute -end-2 -top-2 h-5 w-5 border-e-2 border-t-2 border-primary/45" />
        <span aria-hidden="true" className="pointer-events-none absolute -bottom-2 -start-2 h-5 w-5 border-b-2 border-s-2 border-primary/45" />
        <span aria-hidden="true" className="pointer-events-none absolute -bottom-2 -end-2 h-5 w-5 border-b-2 border-e-2 border-primary/45" />

        <div className="relative rounded-md border border-border/60 bg-card/70 px-6 py-7 backdrop-blur-sm shadow-[0_30px_80px_-50px_hsl(var(--foreground)/0.6)]">
          {/* Header strip */}
          <div className="mb-5 flex items-center justify-between border-b border-border/50 pb-3 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            <span className="text-primary/80">// boot.sequence</span>
            <span>node · admin</span>
          </div>

          {/* Hero row */}
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

          {/* Boot log */}
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

          {/* Segmented progress */}
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

function NotFoundRoute() {
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
  const { t } = useTranslation('shell')
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
    // Don't connect socket until auth is resolved
    if (demoMode) return
    if (isLoading) return
    // If auth is enabled and user is not authenticated, don't connect
    if (authEnabled && !isAuthenticated && !needsSetup) return

    let cancelled = false
    let createdSocket: Socket | null = null
    // Set only while a reconnect_failed recovery is pending (see below);
    // cleared on a successful connect so a recovery reached some other way
    // (the manual Retry button) doesn't leave a stale visibilitychange/
    // online listener registered for the rest of the session.
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

      // Connection established
      newSocket.on('connect', () => {
        disposeRecovery?.()
        disposeRecovery = null
        setConnectionStatus(prev => {
          // Show toast only on reconnect, not initial connect
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
        // Subscribe to updates
        newSocket.emit('subscribe:status')
        newSocket.emit('subscribe:players')
        newSocket.emit('subscribe:logs')
      })

      // Connection lost
      newSocket.on('disconnect', (reason) => {
        setConnectionStatus(prev => ({
          ...prev,
          connected: false,
          error: reason === 'io server disconnect' ? 'Server closed connection' : null,
        }))
      })

      // Connection error with detailed logging (from Socket.IO best practices)
      newSocket.on('connect_error', (err) => {
        if (newSocket.active) {
          // Temporary failure, socket will automatically reconnect
          setConnectionStatus(prev => ({
            ...prev,
            connected: false,
            reconnecting: true,
            error: getUserErrorMessage(err, 'Connection error'),
          }))
        } else {
          // Connection denied by server - needs manual reconnect
          setConnectionStatus({
            connected: false,
            reconnecting: false,
            reconnectAttempt: 0,
            error: getUserErrorMessage(err, 'Connection error'),
          })
        }
      })

      // Reconnection events
      newSocket.io.on('reconnect_attempt', (attempt) => {
        setConnectionStatus(prev => ({
          ...prev,
          reconnecting: true,
          reconnectAttempt: attempt,
        }))
      })

      // socket.io's own reconnectionAttempts (10, with backoff) is left
      // alone -- that part already works. The defect was that giving up
      // was PERMANENT: once reconnect_failed fires, socket.io itself never
      // tries again, and the operator's only way back was F5.
      //
      // Three real events can mean "it's worth trying again now" -- all
      // event-driven, none a timer:
      //   1. the tab was hidden and just became visible again (the operator
      //      wasn't watching; a background tab can still exhaust all 10
      //      attempts while nobody's looking)
      //   2. the browser's network just came back (the actual trigger for
      //      a transient blip)
      //   3. the operator is looking straight at a dead connection with the
      //      tab visible and network fine the whole time -- neither (1) nor
      //      (2) can ever fire for them, so ConnectionStatus.tsx's Retry
      //      button is their only path back
      // All three call newSocket.connect() and nothing else -- the auth
      // function above is what actually does the refresh-if-needed work,
      // so there is exactly one implementation behind all three triggers.
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

        disposeRecovery?.() // replace, don't stack, if this fires more than once in a session
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

  // Auth gate — show loading, setup, or login screens before main app
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
            <Routes>
              <Route path="/" element={<FeatureErrorBoundary featureName={t('nav.dashboard')}><Dashboard /></FeatureErrorBoundary>} />
              <Route path="/dashboard" element={<Navigate to="/" replace />} />
              <Route path="/players" element={<FeatureErrorBoundary featureName={t('nav.items.onlinePlayers')}><Players /></FeatureErrorBoundary>} />
              <Route path="/console" element={<FeatureErrorBoundary featureName={t('nav.items.serverConsole')}><Console /></FeatureErrorBoundary>} />
              <Route path="/scheduler" element={<FeatureErrorBoundary featureName={t('nav.items.scheduledTasks')}><Scheduler /></FeatureErrorBoundary>} />
              <Route path="/mods" element={<FeatureErrorBoundary featureName={t('nav.items.modManager')}><Mods /></FeatureErrorBoundary>} />
              <Route path="/templates" element={<FeatureErrorBoundary featureName={t('nav.items.templates')}><Templates /></FeatureErrorBoundary>} />
              <Route path="/chunks" element={<FeatureErrorBoundary featureName={t('nav.items.mapCleanup')}><ChunkCleaner /></FeatureErrorBoundary>} />
              <Route path="/chunk-cleaner" element={<Navigate to="/chunks" replace />} />
              <Route path="/discord" element={<FeatureErrorBoundary featureName={t('nav.items.discord')}><Discord /></FeatureErrorBoundary>} />
              <Route path="/settings" element={<FeatureErrorBoundary featureName={t('nav.items.panelSettings')}><Settings /></FeatureErrorBoundary>} />
              {/* Users and Roles & Permissions are now tabs inside Settings -- these
                  keep old bookmarks/deep links working rather than 404ing them. */}
              <Route path="/roles" element={<Navigate to="/settings?tab=roles" replace />} />
              <Route path="/users" element={<Navigate to="/settings?tab=users" replace />} />
              <Route path="/sso" element={<Navigate to="/settings?tab=sso" replace />} />
              <Route path="/server-setup" element={<FeatureErrorBoundary featureName={t('nav.items.serverSetup')}><ServerSetup /></FeatureErrorBoundary>} />
              <Route path="/servers" element={<FeatureErrorBoundary featureName={t('nav.items.myServers')}><Servers /></FeatureErrorBoundary>} />
              <Route path="/server-config" element={<FeatureErrorBoundary featureName={t('nav.items.serverConfiguration')}><ServerConfig /></FeatureErrorBoundary>} />
              <Route path="/serverconfig" element={<Navigate to="/server-config" replace />} />
              <Route path="/server-finder" element={<FeatureErrorBoundary featureName={t('nav.items.browsePublic')}><ServerFinder /></FeatureErrorBoundary>} />
              <Route path="/debug" element={<FeatureErrorBoundary featureName={t('nav.items.debugLogs')}><Debug /></FeatureErrorBoundary>} />
              <Route path="/events" element={<FeatureErrorBoundary featureName={t('nav.items.eventsWeather')}><Events /></FeatureErrorBoundary>} />
              <Route path="/world-map" element={<FeatureErrorBoundary featureName={t('nav.items.worldMap')}><WorldMap /></FeatureErrorBoundary>} />
              <Route path="/chat" element={<FeatureErrorBoundary featureName={t('nav.items.inGameChat')}><Chat /></FeatureErrorBoundary>} />
              <Route path="/backups" element={<FeatureErrorBoundary featureName={t('nav.items.worldBackups')}><Backups /></FeatureErrorBoundary>} />
              <Route path="*" element={<NotFoundRoute />} />
            </Routes>
          </Suspense>
        </Layout>
        <Toaster />
      </SocketContext.Provider>
    </ConnectionStatusContext.Provider>
  )
}

function App() {
  // Radix's own direction detection (react-direction's useDirection) has NO
  // fallback to document.documentElement.dir -- without an explicit dir prop
  // or this Provider, every RTL-aware Radix primitive (Slider, Select,
  // Tabs, Accordion, Menu/DropdownMenu, ScrollArea, RovingFocus -- see
  // node_modules/@radix-ui/react-direction's own useDirection: `localDir ||
  // globalDir || "ltr"`, no third fallback) silently stays 'ltr' forever,
  // regardless of the app's actual active language. i18n.language (via
  // useTranslation, so this re-renders on every language switch, not just
  // at boot) is the reactive source of truth here, same as
  // applyDocumentDirection() uses for the <html dir> sync in i18n/index.ts.
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
