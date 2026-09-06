import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { AuthScreenLayout } from '../AuthScreenLayout'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function renderLayout() {
  return render(
    <AuthScreenLayout title="Sign in" description="Access the control panel">
      <p>form goes here</p>
    </AuthScreenLayout>
  )
}

describe('AuthScreenLayout', () => {
  it('starts in the checking state, not a premature online/unreachable claim', () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {})) // never resolves
    renderLayout()
    expect(screen.getByRole('status')).toHaveTextContent('Reaching panel service')
  })

  it('reports the real online state only after /api/health actually succeeds', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ version: '1.2.3' }) } as any)
    renderLayout()

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Panel service online'))
  })

  it('reports unreachable on a failed health check -- it must not keep claiming "checking" or silently show online', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network error'))
    renderLayout()

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Panel service unreachable'))
  })

  it('reports unreachable when the health endpoint responds but with a non-OK status', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as any)
    renderLayout()

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Panel service unreachable'))
  })

  it('renders the real title, description and children content passed in', () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}))
    renderLayout()
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByText('Access the control panel')).toBeInTheDocument()
    expect(screen.getByText('form goes here')).toBeInTheDocument()
  })
})
