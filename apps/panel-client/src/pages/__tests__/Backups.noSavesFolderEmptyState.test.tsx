import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { backupApi, serversApi, type BackupStatus } from '@/lib/api'

// 2026-08-30 visual sweep (fix-backups-dead-spinner-and-debug-environment):
// the main "Backup Files" card showed an infinite spinner whenever
// savesExists was false, even after backupStatus (a DIFFERENT one of
// refreshAll()'s three concurrent fetches) had already resolved to that
// exact fact -- visible in the page's own header at the same moment. These
// tests pin the fix: the card now shows an informative, actionable empty
// state (matching Chunks/Mods' existing pattern for this identical
// condition) as soon as it's known, and never hides a real, pre-existing
// backup list behind it just because the LIVE saves folder is currently
// missing.

let mockCan = (_capability: string) => true

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
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const getHistory = vi.mocked(backupApi.getHistory)

const noFolderStatus: BackupStatus = {
  enabled: false,
  schedule: '0 */6 * * *',
  maxBackups: 10,
  includeDb: true,
  backupInProgress: false,
  restoreInProgress: false,
  lastBackup: null,
  backupCount: 0,
  savesPath: null,
  backupsPath: null,
  savesExists: false,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderBackups() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Backups />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

describe('Backups: no-saves-folder empty state', () => {
  it('shows an informative empty state, not an infinite spinner, once savesExists resolves to false and the backup list is confirmed empty', async () => {
    mockCan = () => true
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus.mockResolvedValue(noFolderStatus)
    listBackups.mockResolvedValue({ backups: [] })
    getHistory.mockResolvedValue({ records: [] })

    renderBackups()

    expect(await screen.findByText('No saves folder found')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /open server setup/i }),
    ).toHaveAttribute('href', '/server-setup')
  })

  it('still shows the real backup list when savesExists is false but backups already exist -- a missing LIVE folder must never hide a pre-existing, restorable backup history', async () => {
    mockCan = () => true
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus.mockResolvedValue(noFolderStatus)
    listBackups.mockResolvedValue({
      backups: [
        { name: 'backup-old', path: '/backups/backup-old.zip', size: 1024, created: '2026-08-01T00:00:00.000Z' },
      ],
    })
    getHistory.mockResolvedValue({ records: [] })

    renderBackups()

    expect(await screen.findByText('backup-old')).toBeInTheDocument()
    expect(screen.queryByText('No saves folder found')).not.toBeInTheDocument()
  })

  it('does not show the no-saves-folder empty state while the backup list fetch is still pending, even after backupStatus has already resolved', async () => {
    mockCan = () => true
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus.mockResolvedValue(noFolderStatus)
    let resolveListBackups!: (value: { backups: [] }) => void
    listBackups.mockReturnValue(
      new Promise((resolve) => {
        resolveListBackups = resolve
      }),
    )
    getHistory.mockResolvedValue({ records: [] })

    renderBackups()

    // The header-level fact resolves (backupStatus is fetched independently)
    // while the backup list is deliberately held pending.
    await waitFor(() => expect(screen.getByText('Saves folder not found')).toBeInTheDocument())
    expect(screen.queryByText('No saves folder found')).not.toBeInTheDocument()

    resolveListBackups({ backups: [] })
    expect(await screen.findByText('No saves folder found')).toBeInTheDocument()
  })
})
