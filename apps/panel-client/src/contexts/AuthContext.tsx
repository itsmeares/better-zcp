import { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import { clearAccessToken, getAccessToken, setAccessToken } from '../lib/authToken'
import { ApiError } from '../lib/api'
import { getUserErrorMessage } from '../lib/errorMessage'
import { getAuthStatusWithFallback } from '../lib/serverAuth'

interface User {
  id: string
  username: string
  role: string
  capabilities: string[] | null
}

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  needsSetup: boolean
  authEnabled: boolean
}

interface AuthContextType extends AuthState {
  login: (username: string, password: string, rememberMe?: boolean) => Promise<void>
  setup: (username: string, password: string, rememberMe?: boolean, panelPort?: string, setupToken?: string) => Promise<void>
  logout: () => Promise<void>
  getToken: () => string | null
  can: (capability: string) => boolean
}

const AuthContext = createContext<AuthContextType | null>(null)

const CORS_LOGIN_MESSAGE = 'Connection blocked by browser origin policy. For first-time reverse-proxy setup, set CORS_ORIGINS to this URL in the panel environment and restart it. Otherwise open the panel from a local/LAN address; after setup, manage origins in Settings > Remote Access.'

async function getErrorPayload(response: Response): Promise<{ error?: string; code?: string } | null> {
  try {
    const data = await response.json()
    return data && typeof data === 'object' ? (data as { error?: string; code?: string }) : null
  } catch {
    return null
  }
}

export const LOGIN_FAILED_MESSAGE = "We couldn't sign you in. Check your username and password and try again."

export function getLoginErrorMessage(error: unknown): string {
  if (error instanceof TypeError) {
    return CORS_LOGIN_MESSAGE
  }
  if (error instanceof Error && /cors|origin policy|failed to fetch/i.test(error.message)) {
    return CORS_LOGIN_MESSAGE
  }
  if (error instanceof ApiError && typeof error.status === 'number' && error.status >= 500) {
    return getUserErrorMessage(error, LOGIN_FAILED_MESSAGE)
  }
  return LOGIN_FAILED_MESSAGE
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
    isLoading: true,
    needsSetup: false,
    authEnabled: true,
  })

  const getToken = useCallback((): string | null => {
    return getAccessToken()
  }, [])

  const checkAuth = useCallback(async () => {
    try {
      const status = await getAuthStatusWithFallback()

      if (status.needsSetup) {
        setState(prev => ({
          ...prev,
          isLoading: false,
          needsSetup: true,
          authEnabled: false,
        }))
        return
      }

      if (!status.authEnabled) {
        setState(prev => ({
          ...prev,
          isLoading: false,
          isAuthenticated: true,
          authEnabled: false,
        }))
        return
      }

      const token = getToken()
      if (token) {
        const meRes = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (meRes.ok) {
          const data = await meRes.json()
          setState({
            user: data.user,
            isAuthenticated: true,
            isLoading: false,
            needsSetup: false,
            authEnabled: true,
          })
          return
        }
        clearAccessToken()
      }

      const refreshRes = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      if (refreshRes.ok) {
        const data = await refreshRes.json()
        setAccessToken(data.accessToken)
        setState({
          user: data.user,
          isAuthenticated: true,
          isLoading: false,
          needsSetup: false,
          authEnabled: true,
        })
        return
      }

      setState(prev => ({
        ...prev,
        isLoading: false,
        isAuthenticated: false,
        authEnabled: true,
      }))
    } catch {
      setState(prev => ({ ...prev, isLoading: false, authEnabled: false }))
    }
  }, [getToken])

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  const login = useCallback(async (username: string, password: string, rememberMe = true) => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // Send/receive cookies
        body: JSON.stringify({ username, password, rememberMe }),
      })

      if (!res.ok) {
        const data = await getErrorPayload(res)
        throw new ApiError(data?.error || LOGIN_FAILED_MESSAGE, { status: res.status, code: data?.code })
      }

      const data = await res.json()
      setAccessToken(data.accessToken)
      setState({
        user: data.user,
        isAuthenticated: true,
        isLoading: false,
        needsSetup: false,
        authEnabled: true,
      })
    } catch (error) {
      throw new ApiError(getLoginErrorMessage(error), {
        status: error instanceof ApiError ? error.status : undefined,
      })
    }
  }, [])

  const setup = useCallback(async (username: string, password: string, rememberMe = true, panelPort = '3001', setupToken = '') => {
    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password, rememberMe, panelPort, setupToken }),
    })

    if (!res.ok) {
      const data = await res.json()
      if (data.code === 'SETUP_TOKEN_REQUIRED') {
        throw new Error('SETUP_TOKEN_REQUIRED')
      }
      throw new ApiError(data.error || "We couldn't create the admin account. Try again.", {
        status: res.status,
        code: data.code,
      })
    }

    const data = await res.json()
    setAccessToken(data.accessToken)
    setState({
      user: data.user,
      isAuthenticated: true,
      isLoading: false,
      needsSetup: false,
      authEnabled: true,
    })
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } catch {
      // Ignore logout errors
    }
    clearAccessToken()
    setState(prev => ({
      ...prev,
      user: null,
      isAuthenticated: false,
    }))
  }, [])

  const can = useCallback(
    (capability: string) => {
      const capabilities = state.user?.capabilities
      if (capabilities == null) return true
      return capabilities.includes(capability)
    },
    [state.user],
  )

  return (
    <AuthContext.Provider value={useMemo(() => ({ ...state, login, setup, logout, getToken, can }), [state, login, setup, logout, getToken, can])}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- hook intentionally co-located with its provider
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
