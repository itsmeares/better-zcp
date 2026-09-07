import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import './index.css'
import './i18n'
import { isDemoMode, installDemoFetchShim } from './lib/demo'
import { router } from './router'

if (isDemoMode()) {
  installDemoFetchShim()
  if (!window.location.hash) {
    window.location.hash = '#/'
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
