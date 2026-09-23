import { Outlet, useLocation } from '@tanstack/react-router'
import { useEffect, useState, useCallback, Suspense } from 'react'
import type { Socket } from 'socket.io-client'
import Layout from './components/Layout'
import {
  SocketContext,
  ConnectionStatus,
  ConnectionStatusContext,
} from './contexts/SocketContext'
import { ConfirmProvider } from './contexts/ConfirmContext'
import { useAuth } from './contexts/AuthContext'
import { isDemoMode } from './lib/demo'
import { useToast } from './components/ui/use-toast'
import { PageSkeleton } from './components/PageSkeleton'
import { ScrollToTop } from './components/ScrollToTop'
import { getUserErrorMessage } from './lib/errorMessage'
import { createSocketAuthProvider } from './lib/socketAuth'
import { registerReconnectRecovery } from './lib/socketRecovery'

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
    description:
      'Loading live server state, players, actions, and maintenance telemetry.',
    eyebrow: '// LIVE · OVERVIEW',
    variant: 'dashboard',
    metrics: ['status', 'players', 'rcon'],
  },
  '/players': {
    title: 'Online Players',
    description:
      'Preparing player rows, admin actions, notes, and session details.',
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
  '/world-map': {
    title: 'World Map',
    description: 'Loading map tiles, marker tools, and player/world overlays.',
    eyebrow: '// WORLD · MAP',
    variant: 'map',
    metrics: ['tiles', 'markers', 'layers'],
  },
  '/server-config': {
    title: 'Server Configuration',
    description:
      'Loading INI sections, validation, and server-safe edit controls.',
    eyebrow: '// CONFIG · INI',
    variant: 'form',
    metrics: ['ini', 'validate', 'save'],
  },
  '/mods': {
    title: 'Mod Manager',
    description:
      'Loading Workshop status, active mod IDs, conflicts, and update state.',
    eyebrow: '// CONFIG · WORKSHOP',
    variant: 'list',
    metrics: ['workshop', 'mods', 'conflicts'],
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
    description:
      'Loading backup inventory, restore controls, and storage status.',
    eyebrow: '// MAINTAIN · BACKUPS',
    variant: 'list',
    metrics: ['files', 'storage', 'restore'],
  },
  '/servers': {
    title: 'My Servers',
    description:
      'Loading server profiles, active target, and connection details.',
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
  '/settings': {
    title: 'Panel Settings',
    description:
      'Loading access, paths, network, and panel preference controls.',
    eyebrow: '// SYSTEM · SETTINGS',
    variant: 'form',
    metrics: ['auth', 'paths', 'network'],
  },
  '/debug': {
    title: 'Debug Logs',
    description:
      'Preparing diagnostics, probes, logs, and support bundle tools.',
    eyebrow: '// SYSTEM · DIAGNOSTICS',
    variant: 'console',
    metrics: ['logs', 'probes', 'bundle'],
  },
}

function PageLoader() {
  const { pathname } = useLocation()
  const meta = ROUTE_LOADERS[pathname] || ROUTE_LOADERS['/']
  return <PageSkeleton {...meta} />
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
  const { getToken } = useAuth()

  const handleReconnectSuccess = useCallback(() => {
    toast({
      title: 'Reconnected',
      description: 'Connection to server restored',
      variant: 'success' as const,
    })
  }, [toast])

  useEffect(() => {
    if (demoMode) return

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
        setConnectionStatus((prev) => {
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
        setConnectionStatus((prev) => ({
          ...prev,
          connected: false,
          error:
            reason === 'io server disconnect'
              ? 'Server closed connection'
              : null,
        }))
      })

      newSocket.on('connect_error', (err) => {
        if (newSocket.active) {
          setConnectionStatus((prev) => ({
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
        setConnectionStatus((prev) => ({
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
          description:
            'Unable to reconnect automatically. Reconnecting once this tab is visible or your network is back — or use Retry in the connection status indicator.',
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
  }, [
    toast,
    handleReconnectSuccess,
    getToken,
    demoMode,
  ])

  return (
    <ConnectionStatusContext.Provider value={connectionStatus}>
      <SocketContext.Provider value={socket}>
        <Layout>
          <ScrollToTop />
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </Layout>
      </SocketContext.Provider>
    </ConnectionStatusContext.Provider>
  )
}

function App() {
  return (
    <ConfirmProvider>
      <AppContent />
    </ConfirmProvider>
  )
}

export default App
