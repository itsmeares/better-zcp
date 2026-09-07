import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BuildCompatibilityGate } from '../BuildCompatibilityGate'

function renderGate() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <BuildCompatibilityGate>
        <p>Panel content</p>
      </BuildCompatibilityGate>
    </QueryClientProvider>,
  )
}

describe('BuildCompatibilityGate', () => {
  beforeEach(() => {
    vi.stubGlobal('__PANEL_VERSION__', '2.0.0')
    vi.stubGlobal('__PANEL_BUILD_SHA__', 'frontend-build')
    vi.stubGlobal('__PANEL_API_CONTRACT_VERSION__', 1)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('blocks a mismatched backend before rendering the panel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        panelVersion: '1.9.0',
        buildSha: 'backend-build',
        apiContractVersion: 1,
      }),
    }))

    renderGate()

    await waitFor(() => expect(screen.getByText('Frontend and backend versions do not match')).toBeInTheDocument())
    expect(screen.queryByText('Panel content')).not.toBeInTheDocument()
  })

  it('fails open when the compatibility check cannot reach the backend', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    renderGate()

    await waitFor(() => expect(screen.getByText('Panel content')).toBeInTheDocument())
  })
})
