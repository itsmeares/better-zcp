import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import ServerSetup, { INSTALL_INFLIGHT_KEY } from '../ServerSetup'
import { serversApi } from '@/lib/api'
import enServerSetup from '../../locales/en/serverSetup.json'

// 2026-08-26 install-failure hunt (finding #7) + god's follow-up dispatch:
// install:complete/install:log are heard by exactly one file in the whole
// client (this one), and a tab closed or reloaded mid-download loses the
// eventual outcome entirely -- no persisted state, no way back. This file
// covers the two CLIENT-side fixes from that dispatch:
//   1. The resume banner: a marker left by a previous page load is surfaced
//      on remount instead of silently forgotten.
//   2. The create-vs-activate split (finding #2): a server that WAS created
//      but failed to auto-activate must never be reported as "failed to
//      create server entry" -- that told the operator the whole thing failed
//      when only the auto-switch-active-server step had.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, create: vi.fn(), activate: vi.fn() },
  }
})

// bug-hunt-2026-08-27: ServerSetup.tsx gained its first useAuth() call for
// capability gating -- outside an AuthProvider that throws, which this file
// never wrapped in one because it never needed one before. can() fails open
// (returns true) so none of the assertions below, none of which are about
// capability gating, are affected by it.
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

// useToast's own store is a module-level singleton (memoryState, not React
// state) with no reset hook -- toasts from an earlier test in this same file
// would otherwise still be sitting in the DOM (TOAST_LIMIT=5) when the next
// test's <Toaster/> renders, making "the wrong toast did NOT appear"
// unprovable. Mock it with a plain spy instead, cleared per test.
const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const create = vi.mocked(serversApi.create)
const activate = vi.mocked(serversApi.activate)

// Minimal fake matching only what ServerSetup actually calls (on/off) --
// real socket.io-client is not needed to prove these two behaviors.
function createFakeSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const socket = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler)
    }),
    emit: vi.fn(),
  }
  return {
    socket: socket as unknown as Socket,
    trigger: (event: string, data?: unknown) => {
      listeners.get(event)?.forEach((h) => h(data))
    },
  }
}

function renderServerSetup(socket: Socket | null = null) {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={socket}>
        <TooltipProvider>
          <ServerSetup />
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  create.mockReset()
  activate.mockReset()
  toastSpy.mockClear()
})

describe('ServerSetup -- resume banner for an install left running by a previous page load', () => {
  it('shows nothing when no marker was left behind', async () => {
    renderServerSetup()
    await screen.findByText(enServerSetup.modeSelect.title)
    expect(screen.queryByText(enServerSetup.resumeBanner.title)).not.toBeInTheDocument()
  })

  it('surfaces a fresh marker with the install path it names, and Dismiss clears it for good', async () => {
    localStorage.setItem(
      INSTALL_INFLIGHT_KEY,
      JSON.stringify({ installPath: '/srv/pz-fresh', serverName: 'fresh-server', startedAt: Date.now() - 60_000 }),
    )
    renderServerSetup()

    await screen.findByText(enServerSetup.resumeBanner.title)
    expect(screen.getByText(/\/srv\/pz-fresh/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: enServerSetup.resumeBanner.dismissButton }))

    expect(screen.queryByText(enServerSetup.resumeBanner.title)).not.toBeInTheDocument()
    expect(localStorage.getItem(INSTALL_INFLIGHT_KEY)).toBeNull()
  })

  it('treats a marker older than the stale threshold as gone, not as "still running"', async () => {
    localStorage.setItem(
      INSTALL_INFLIGHT_KEY,
      JSON.stringify({ installPath: '/srv/pz-old', serverName: 'old-server', startedAt: Date.now() - 7 * 60 * 60 * 1000 }),
    )
    renderServerSetup()

    // Give the mount effect a tick, then confirm the banner never appears
    // and the stale marker was cleaned up rather than left to nag forever.
    await screen.findByText(enServerSetup.modeSelect.title)
    expect(screen.queryByText(enServerSetup.resumeBanner.title)).not.toBeInTheDocument()
    expect(localStorage.getItem(INSTALL_INFLIGHT_KEY)).toBeNull()
  })

  it('Continue setup pre-fills the install path/server name and drops straight into the full wizard', async () => {
    localStorage.setItem(
      INSTALL_INFLIGHT_KEY,
      JSON.stringify({ installPath: '/srv/pz-continue', serverName: 'continue-server', startedAt: Date.now() - 60_000 }),
    )
    renderServerSetup()

    await screen.findByText(enServerSetup.resumeBanner.title)
    fireEvent.click(screen.getByRole('button', { name: enServerSetup.resumeBanner.continueButton }))

    // Landed past the mode-select screen (its title is gone) and the install
    // path field carries the marker's value forward instead of starting blank.
    await waitFor(() => expect(screen.queryByText(enServerSetup.modeSelect.title)).not.toBeInTheDocument())
    expect(screen.getByDisplayValue('/srv/pz-continue')).toBeInTheDocument()
  })
})

describe('ServerSetup -- install:complete create-vs-activate messaging (finding #2)', () => {
  const successPayload = {
    success: true,
    message: 'Server installed successfully',
    installPath: '/srv/pz',
    serverName: 'myserver',
    rconPort: 27015,
    serverPort: 16261,
    minMemory: 4,
    maxMemory: 8,
  }

  it('reports registration failure (not activation failure) when create() itself throws', async () => {
    create.mockRejectedValue(new Error('db write failed'))
    const fake = createFakeSocket()
    renderServerSetup(fake.socket)
    await screen.findByText(enServerSetup.modeSelect.title)

    fake.trigger('install:complete', successPayload)

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: enServerSetup.toasts.registerFailedTitle }),
      ),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: enServerSetup.toasts.activateFailedTitle }),
    )
    expect(activate).not.toHaveBeenCalled()
  })

  it('reports activation failure specifically -- not "failed to create" -- when create() succeeds but activate() throws', async () => {
    create.mockResolvedValue({ server: { id: 42 } } as unknown as Awaited<ReturnType<typeof serversApi.create>>)
    activate.mockRejectedValue(new Error('activate failed'))
    const fake = createFakeSocket()
    renderServerSetup(fake.socket)
    await screen.findByText(enServerSetup.modeSelect.title)

    fake.trigger('install:complete', successPayload)

    // The bug this covers: this used to say "Server files installed, but
    // registration failed" here, even though the server WAS registered.
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: enServerSetup.toasts.activateFailedTitle }),
      ),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: enServerSetup.toasts.registerFailedTitle }),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: enServerSetup.toasts.serverInstalledTitle }),
    )
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('reports full success when both create() and activate() succeed', async () => {
    create.mockResolvedValue({ server: { id: 42 } } as unknown as Awaited<ReturnType<typeof serversApi.create>>)
    activate.mockResolvedValue({ server: { id: 42 } } as unknown as Awaited<ReturnType<typeof serversApi.activate>>)
    const fake = createFakeSocket()
    renderServerSetup(fake.socket)
    await screen.findByText(enServerSetup.modeSelect.title)

    fake.trigger('install:complete', successPayload)

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: enServerSetup.toasts.serverInstalledTitle }),
      ),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: enServerSetup.toasts.registerFailedTitle }),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: enServerSetup.toasts.activateFailedTitle }),
    )
  })

  it('clears the in-flight marker as soon as an outcome is heard, success or failure', async () => {
    localStorage.setItem(
      INSTALL_INFLIGHT_KEY,
      JSON.stringify({ installPath: '/srv/pz', serverName: 'myserver', startedAt: Date.now() }),
    )
    create.mockRejectedValue(new Error('db write failed'))
    const fake = createFakeSocket()
    renderServerSetup(fake.socket)
    await screen.findByText(enServerSetup.modeSelect.title)

    fake.trigger('install:complete', { ...successPayload, success: false, message: 'boom' })

    await waitFor(() => expect(localStorage.getItem(INSTALL_INFLIGHT_KEY)).toBeNull())
  })
})
