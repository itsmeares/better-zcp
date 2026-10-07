import { lazy, Suspense } from 'react'
import { DirectionProvider } from '@radix-ui/react-direction'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AuthScreenLoader } from './components/AuthScreenLoader'
import { TooltipProvider } from './components/ui-legacy/tooltip'
import { ToastProvider } from './components/ui/toast'

const App = lazy(() => import('./App'))
const Login = lazy(() => import('./pages/Login'))
const Setup = lazy(() => import('./pages/Setup'))

function AuthGate() {
  const { isLoading, needsSetup, authEnabled, isAuthenticated } = useAuth()
  if (isLoading) return <AuthScreenLoader />

  return (
    <Suspense fallback={<AuthScreenLoader />}>
      {needsSetup ? <Setup /> : authEnabled && !isAuthenticated ? <Login /> : <App />}
    </Suspense>
  )
}

export default function AppShell() {
  return (
    <ErrorBoundary>
      <DirectionProvider dir="ltr">
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <AuthProvider>
                <AuthGate />
              </AuthProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </DirectionProvider>
    </ErrorBoundary>
  )
}
