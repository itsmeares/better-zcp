import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

export function ScrollToTop() {
  const { pathname } = useLocation()

  useEffect(() => {
    const main = document.querySelector('main')
    if (main) {
      main.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    }
  }, [pathname])

  return null
}
