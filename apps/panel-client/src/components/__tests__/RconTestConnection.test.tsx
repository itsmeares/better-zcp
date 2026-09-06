import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { RconTestConnection } from '../RconTestConnection'
import { rconApi } from '@/lib/api'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    rconApi: { testConnection: vi.fn() },
  }
})

const testConnection = vi.mocked(rconApi.testConnection)

beforeEach(() => {
  testConnection.mockReset()
})

function renderIt(props: Partial<{ host: string; port: number; password: string }> = {}) {
  return render(
    <MemoryRouter>
      <RconTestConnection host="10.0.0.5" port={27015} password="pw" {...props} />
    </MemoryRouter>
  )
}

describe('RconTestConnection', () => {
  it('disables the test button when host is blank', () => {
    renderIt({ host: '  ' })
    expect(screen.getByRole('button', { name: 'Test Connection' })).toBeDisabled()
  })

  it('disables the test button when port is falsy', () => {
    renderIt({ port: 0 })
    expect(screen.getByRole('button', { name: 'Test Connection' })).toBeDisabled()
  })

  it('reports real success, not just "no error"', async () => {
    testConnection.mockResolvedValue({ success: true, detail: 'Authenticated as admin' })
    renderIt()
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }))

    expect(await screen.findByText('Authenticated as admin')).toBeInTheDocument()
    expect(screen.getByRole('status')).not.toHaveClass('text-destructive')
  })

  it('distinguishes unreachable host from wrong password rather than a generic failure', async () => {
    testConnection.mockResolvedValue({ success: false, error: 'auth_failed', detail: 'Authentication failed: wrong password' })
    renderIt()
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }))

    expect(await screen.findByText('Authentication failed: wrong password')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveClass('text-destructive')
  })

  it('shows a failure state when the request itself throws, instead of hanging or reporting success', async () => {
    testConnection.mockRejectedValue(new Error('network blip'))
    renderIt()
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveClass('text-destructive'))
  })

  it('clears the previous result before starting a new test, so a stale success cannot linger under a new run', async () => {
    testConnection.mockResolvedValueOnce({ success: true, detail: 'ok first time' })
    renderIt()
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }))
    expect(await screen.findByText('ok first time')).toBeInTheDocument()

    let resolveSecond: (v: { success: boolean; detail: string }) => void
    testConnection.mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }))

    expect(screen.queryByText('ok first time')).not.toBeInTheDocument()
    resolveSecond!({ success: true, detail: 'ok second time' })
    expect(await screen.findByText('ok second time')).toBeInTheDocument()
  })
})
