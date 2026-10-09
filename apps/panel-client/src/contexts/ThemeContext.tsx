import { createContext, useContext, useEffect, useState, useCallback, useMemo, ReactNode } from 'react'

export type ThemeName = 'light' | 'dark' | 'system'

// Shared with the boot script in index.html, which applies the class before paint.
const STORAGE_KEY = 'pz-panel-theme'

// Before 3.0 the dark theme was stored as "survival".
function parseTheme(value: string | null): ThemeName {
  if (value === 'light' || value === 'dark' || value === 'system') return value
  if (value === 'survival') return 'dark'
  return 'system'
}

function getStoredTheme(): ThemeName {
  try {
    return parseTheme(localStorage.getItem(STORAGE_KEY))
  } catch {
    return 'system'
  }
}

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

function applyTheme(theme: ThemeName) {
  const dark = theme === 'dark' || (theme === 'system' && systemDark())
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.classList.toggle('light', !dark)
}

interface ThemeContextValue {
  theme: ThemeName
  setTheme: (t: ThemeName) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'system',
  setTheme: () => {},
})

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(getStoredTheme)

  const setTheme = useCallback((t: ThemeName) => {
    setThemeState(t)
    try { localStorage.setItem(STORAGE_KEY, t) } catch { /* storage may be unavailable */ }
  }, [])

  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme('system')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [theme])

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme])

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- hook intentionally co-located with its provider
export function useTheme() {
  return useContext(ThemeContext)
}
