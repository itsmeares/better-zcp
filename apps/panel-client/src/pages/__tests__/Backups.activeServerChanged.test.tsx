import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { backupApi, serversApi, type BackupStatus, type ServerBackupArchive } from '@/lib/api'


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
      restoreBackup: vi.fn(),
    },
  }
})

const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: () => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: () => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const getHistory = vi.mocked(backupApi.getHistory)
const createBackup = vi.mocked(backupApi.createBackup)
const restoreBackup = vi.mocked(backupApi.restoreBackup)

const testStatus: BackupStatus = {
  enabled: true, schedule: '0 */6 * * *', maxBackups: 10, includeDb: true,
  backupInProgress: false, restoreInProgress: false, lastBackup: null,
  backupCount: 1, savesPath: '/saves', backupsPath: '/backups', savesExists: true,
}
const testBackup: ServerBackupArchive = {
  name: 'backup-2026-08-27T00-00-00',
  path: '/backups/backup-2026-08-27T00-00-00.zip',
  size: 1024 * 1024,
  created: '2026-08-27T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

function renderBackups() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Backups />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

describe('Backups.tsx: activeServerChanged', () => {
  it('reloads unconditionally (no unsaved user input here worth protecting, unlike ServerConfig)', async () => {
    getResolvedActive.mockResolvedValue({ server: { id: 1, name: 'Ashenwood' } as never })
    getStatus.mockResolvedValue(testStatus)
    listBackups.mockResolvedValue({ backups: [testBackup] })
    getHistory.mockResolvedValue({ records: [] })

    renderBackups()
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1))

    act(() => { emitActiveServerChanged() })

    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2), { timeout: 2000 })
    expect(getResolvedActive).toHaveBeenCalledTimes(2)
    expect(listBackups).toHaveBeenCalledTimes(2)
  })

  it('closes an open restore dialog and blocks Create/Restore until the reload lands', async () => {
    getResolvedActive.mockResolvedValue({ server: { id: 1, name: 'Ashenwood' } as never })
    getStatus.mockResolvedValue(testStatus)
    listBackups.mockResolvedValue({ backups: [testBackup] })
    getHistory.mockResolvedValue({ records: [] })
    createBackup.mockResolvedValue({ success: true, backup: testBackup, duration: 1.2 })
    restoreBackup.mockResolvedValue({ success: true, duration: 3.4 })

    renderBackups()
    const restoreButton = await screen.findByRole('button', { name: /restore/i })
    fireEvent.click(restoreButton)
    expect(await screen.findByRole('button', { name: /restore this backup/i })).toBeInTheDocument()

    let resolveReload!: () => void
    getResolvedActive.mockReturnValue(new Promise((r) => { resolveReload = () => r({ server: { id: 2, name: 'Brightmoor' } as never }) }))

    act(() => { emitActiveServerChanged() })

    await waitFor(() => expect(screen.queryByRole('button', { name: /restore this backup/i })).not.toBeInTheDocument())

    const createButton = screen.getByRole('button', { name: /create backup/i })
    expect(createButton).toBeDisabled()
    fireEvent.click(createButton)
    expect(createBackup).not.toHaveBeenCalled()

    resolveReload()
    await waitFor(() => expect(createButton).not.toBeDisabled())
  })

  it('restore confirmation names the real target server, read fresh when the dialog opens', async () => {
    getResolvedActive.mockResolvedValue({ server: { id: 1, name: 'Ashenwood' } as never })
    getStatus.mockResolvedValue(testStatus)
    listBackups.mockResolvedValue({ backups: [testBackup] })
    getHistory.mockResolvedValue({ records: [] })

    renderBackups()
    const restoreButton = await screen.findByRole('button', { name: /restore/i })
    fireEvent.click(restoreButton)

    expect(await screen.findByText('Ashenwood')).toBeInTheDocument()
  })
})
