import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, HashRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import './i18n'
import { isDemoMode, installDemoFetchShim } from './lib/demo'
import { BuildCompatibilityGate } from './components/BuildCompatibilityGate'
import { queryClient } from './lib/queryClient'

const Router = isDemoMode() ? HashRouter : BrowserRouter

if (isDemoMode()) {
  installDemoFetchShim()
  if (!window.location.hash) {
    window.location.hash = '#/'
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router>
        <BuildCompatibilityGate>
          <App />
        </BuildCompatibilityGate>
      </Router>
    </QueryClientProvider>
  </React.StrictMode>,
)
