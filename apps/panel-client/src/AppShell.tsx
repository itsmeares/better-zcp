import { lazy, Suspense } from 'react'
import { DirectionProvider } from '@radix-ui/react-direction'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AuthScreenLoader } from './components/AuthScreenLoader'
import { TooltipProvider } from './components/ui/tooltip'
import { Toaster } from './components/ui/toaster'

const App = lazy(() => import('./App'))
const Login = lazy(() => import('./pages/Login'))
const Setup = lazy(() => import('./pages/Setup'))

function AuthGate() {
  const { isLoading, needsSetup, authEnabled, isAuthenticated } = useAuth()
  if (isLoading) return <AuthScreenLoader />

  return (
    <Suspense fallback={<AuthScreenLoader />}>
      {needsSetup ? <Setup /> : authEnabled && !isAuthenticated ? <Login /> : <App />}
      <Toaster />
    </Suspense>
  )
}

export default function AppShell() {
  return (
    <ErrorBoundary>
      <DirectionProvider dir="ltr">
        <ThemeProvider>
          <TooltipProvider>
            <AuthProvider>
              <AuthGate />
            </AuthProvider>
          </TooltipProvider>
        </ThemeProvider>
      </DirectionProvider>
    </ErrorBoundary>
  )
}
