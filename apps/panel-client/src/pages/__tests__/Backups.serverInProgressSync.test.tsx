import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
      downloadBackup: vi.fn(),
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const getHistory = vi.mocked(backupApi.getHistory)

const baseStatus: BackupStatus = {
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
  name: 'backup-2026-09-03T00-00-00',
  path: '/backups/backup-2026-09-03T00-00-00.zip',
  size: 1024 * 1024,
  created: '2026-09-03T00:00:00.000Z',
}

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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('Backups.tsx: reflects the server-side backupInProgress/restoreInProgress mutex it was ignoring', () => {
  it('a fresh page load while a backup is already running shows it running, not idle', async () => {
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus.mockResolvedValue({ ...baseStatus, backupInProgress: true })
    listBackups.mockResolvedValue({ backups: [testBackup] })
    getHistory.mockResolvedValue({ records: [] })

    renderBackups()

    const createButton = await screen.findByRole('button', { name: /creating/i })
    expect(createButton).toBeDisabled()
  })

  it('a fresh page load while a restore is already running (started elsewhere) disables Create/Upload/Restore instead of inviting a conflicting click', async () => {
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus.mockResolvedValue({ ...baseStatus, restoreInProgress: true })
    listBackups.mockResolvedValue({ backups: [testBackup] })
    getHistory.mockResolvedValue({ records: [] })

    renderBackups()

    const createButton = await screen.findByRole('button', { name: /create backup/i })
    const uploadButton = await screen.findByRole('button', { name: /upload/i })
    const restoreButton = await screen.findByRole('button', { name: /restore/i })

    expect(createButton).toBeDisabled()
    expect(uploadButton).toBeDisabled()
    expect(restoreButton).toBeDisabled()
  })

  it('control: neither flag set -- everything stays enabled as before', async () => {
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus.mockResolvedValue(baseStatus)
    listBackups.mockResolvedValue({ backups: [testBackup] })
    getHistory.mockResolvedValue({ records: [] })

    renderBackups()

    const createButton = await screen.findByRole('button', { name: /create backup/i })
    await waitFor(() => expect(createButton).not.toBeDisabled())
  })

  it('rechecks an externally-running backup when its completion socket event is missed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus
      .mockResolvedValueOnce({ ...baseStatus, backupInProgress: true })
      .mockResolvedValue({ ...baseStatus, backupInProgress: false })
    listBackups.mockResolvedValue({ backups: [testBackup] })
    getHistory.mockResolvedValue({ records: [] })

    renderBackups()

    await vi.waitFor(() => expect(screen.getByRole('button', { name: /creating/i })).toBeDisabled())
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /create backup/i })).not.toBeDisabled())
  })
})
