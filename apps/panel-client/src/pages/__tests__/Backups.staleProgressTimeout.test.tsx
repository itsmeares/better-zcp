import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Backups from '../Backups'
import { backupApi, serversApi, type BackupStatus, type ServerBackupArchive } from '@/lib/api'

// 2026-08-31 bug hunt: handleCreateBackup's optimistic 'preparing' state
// (kicked off by clicking Create Backup) never clears any PENDING
// progressTimeoutRef left over from a PREVIOUS backup's 'complete'/'error'
// socket event -- only the socket handler itself and the catch branch do
// that defensive clear. A second "Create Backup" click within the ~2-3s
// auto-clear window of the FIRST backup's completion starts a fresh
// progress display that a leftover timer then wipes out from underneath
// it, mid-operation, well before the second backup is actually done.

const mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn() },
    backupApi: {
      ...actual.backupApi,
      getStatus: vi.fn(),
      listBackups: vi.fn(),
      getHistory: vi.fn(),
      createBackup: vi.fn(),
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const getHistory = vi.mocked(backupApi.getHistory)
const createBackup = vi.mocked(backupApi.createBackup)

const testStatus: BackupStatus = {
  enabled: true,
  schedule: '0 */6 * * *',
  maxBackups: 10,
  includeDb: true,
  backupInProgress: false,
  restoreInProgress: false,
  lastBackup: null,
  backupCount: 1,
  savesPath: '/saves',
  backupsPath: '/backups',
  savesExists: true,
}

const testBackup: ServerBackupArchive = {
  name: 'backup-2026-08-31T00-00-00',
  path: '/backups/backup-2026-08-31T00-00-00.zip',
  size: 1024,
  created: '2026-08-31T00:00:00.000Z',
}

function makeMockSocket() {
  const handlers: Record<string, (data: unknown) => void> = {}
  const socket = {
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    off: (event: string) => { delete handlers[event] },
  }
  return { socket, fire: (event: string, data: unknown) => handlers[event]?.(data) }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

function renderBackups(socket: Pick<Socket, 'on' | 'off'>) {
  return render(
    <SocketContext.Provider value={socket as Socket}>
      <TooltipProvider>
        <Backups />
      </TooltipProvider>
    </SocketContext.Provider>,
  )
}

describe('Backups.tsx: stale progress-clear timeout across back-to-back backups', () => {
  it('does not wipe a second backup\'s live progress using a leftover timeout scheduled by the first backup\'s completion', async () => {
    const { socket, fire } = makeMockSocket()
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus.mockResolvedValue(testStatus)
    listBackups.mockResolvedValue({ backups: [testBackup] })
    getHistory.mockResolvedValue({ records: [] })
    createBackup.mockResolvedValueOnce({ success: true, backup: testBackup, duration: 0.1 })
    // Second click's createBackup() call deliberately never resolves during
    // this test -- it stands in for a still-in-flight second backup.
    createBackup.mockReturnValueOnce(new Promise(() => {}))

    // Real timers for mount + the first click's async settling -- mixing
    // fake timers with RTL's waitFor (which polls on real timers) deadlocks.
    renderBackups(socket)
    const createButton = await screen.findByRole('button', { name: /create backup/i })
    await act(async () => { fireEvent.click(createButton) })
    await waitFor(() => expect(createBackup).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(createButton).not.toBeDisabled())

    // Now take over time explicitly for the race itself.
    vi.useFakeTimers()
    try {
      // Backup #1's 'complete' socket event arrives, scheduling a 2000ms
      // auto-clear of the progress card (Backups.tsx's own documented
      // behavior).
      act(() => { fire('backup:progress', { phase: 'complete', percent: 100, message: 'Backup complete' }) })

      // Still well inside that 2000ms window.
      await vi.advanceTimersByTimeAsync(500)

      // Operator clicks Create again right away -- a second backup starts.
      act(() => { fireEvent.click(createButton) })
      await vi.advanceTimersByTimeAsync(0)
      expect(createBackup).toHaveBeenCalledTimes(2)
      expect(screen.getByText('Starting backup...')).toBeInTheDocument()

      // Cross the ORIGINAL clear deadline from backup #1's completion
      // (500ms already elapsed + 1600ms more = 2100ms total since that
      // event).
      await vi.advanceTimersByTimeAsync(1600)

      // The second backup's own createBackup() promise never resolved (it
      // is still genuinely running), so its progress state must still be
      // shown.
      expect(screen.getByText('Starting backup...')).toBeInTheDocument()
      expect(screen.queryByText('Creating backup...')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
