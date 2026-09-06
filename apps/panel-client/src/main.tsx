import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import './index.css'
import './i18n'
import { isDemoMode, installDemoFetchShim } from './lib/demo'
import { BuildCompatibilityGate } from './components/BuildCompatibilityGate'
import { queryClient } from './lib/queryClient'
import { router } from './router'

if (isDemoMode()) {
  installDemoFetchShim()
  if (!window.location.hash) {
    window.location.hash = '#/'
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BuildCompatibilityGate>
        <RouterProvider router={router} />
      </BuildCompatibilityGate>
    </QueryClientProvider>
  </React.StrictMode>,
)
