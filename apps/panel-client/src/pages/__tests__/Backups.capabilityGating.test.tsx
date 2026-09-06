import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { backupApi, serversApi, type BackupStatus, type ServerBackupArchive } from '@/lib/api'

// 2026-08-27 bug-hunt: Backups.tsx had NO test file at all before this one
// (god's f7ac68) -- it was gated for backups.manage/backups.restore/
// backups.download in 22743fe and hardened with function-level guards in
// 3e46b62, but neither commit had any coverage. This covers all three
// capabilities in both directions: denied -> control disabled AND a click
// never reaches the API; granted -> click goes all the way through to a
// real API call (through the confirm dialog for restore, since that's the
// realistic click path an operator takes).

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
const createBackup = vi.mocked(backupApi.createBackup)
const restoreBackup = vi.mocked(backupApi.restoreBackup)
const downloadBackup = vi.mocked(backupApi.downloadBackup)

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
  name: 'backup-2026-08-27T00-00-00',
  path: '/backups/backup-2026-08-27T00-00-00.zip',
  size: 1024 * 1024,
  created: '2026-08-27T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderBackups() {
  return render(
    <TooltipProvider>
      <Backups />
    </TooltipProvider>,
  )
}

function setUp() {
  getResolvedActive.mockResolvedValue({ server: null })
  getStatus.mockResolvedValue(testStatus)
  listBackups.mockResolvedValue({ backups: [testBackup] })
  getHistory.mockResolvedValue({ records: [] })
  createBackup.mockResolvedValue({ success: true, backup: testBackup, duration: 1.2 })
  restoreBackup.mockResolvedValue({ success: true, duration: 3.4 })
  downloadBackup.mockResolvedValue(undefined)
}

describe('Backups.tsx: backups.manage gates Create Backup', () => {
  it('disables Create Backup and a click never calls the API when the role lacks backups.manage', async () => {
    mockCan = (capability) => capability !== 'backups.manage'
    setUp()
    renderBackups()

    const createButton = await screen.findByRole('button', { name: /create backup/i })
    expect(createButton).toBeDisabled()

    fireEvent.click(createButton)
    await waitFor(() => expect(createBackup).not.toHaveBeenCalled())
  })

  it('enables Create Backup and a click calls createBackup when the role holds backups.manage', async () => {
    mockCan = () => true
    setUp()
    renderBackups()

    const createButton = await screen.findByRole('button', { name: /create backup/i })
    expect(createButton).not.toBeDisabled()

    fireEvent.click(createButton)
    await waitFor(() => expect(createBackup).toHaveBeenCalledTimes(1))
  })
})

describe('Backups.tsx: backups.restore gates the restore flow', () => {
  it('disables the row Restore button and it never opens the confirm dialog when the role lacks backups.restore', async () => {
    mockCan = (capability) => capability !== 'backups.restore'
    setUp()
    renderBackups()

    const restoreButton = await screen.findByRole('button', { name: /restore/i })
    expect(restoreButton).toBeDisabled()

    fireEvent.click(restoreButton)
    await waitFor(() => expect(restoreBackup).not.toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /restore this backup/i })).not.toBeInTheDocument()
  })

  it('opens the confirm dialog and clicking through calls restoreBackup when the role holds backups.restore', async () => {
    mockCan = () => true
    setUp()
    renderBackups()

    const restoreButton = await screen.findByRole('button', { name: /restore/i })
    expect(restoreButton).not.toBeDisabled()
    fireEvent.click(restoreButton)

    const confirmButton = await screen.findByRole('button', { name: /restore this backup/i })
    fireEvent.click(confirmButton)

    await waitFor(() => expect(restoreBackup).toHaveBeenCalledWith(testBackup.name, { createPreRestoreBackup: true }))
  })
})

describe('Backups.tsx: backups.download gates the download button', () => {
  it('disables Download and a click never calls the API when the role lacks backups.download', async () => {
    mockCan = (capability) => capability !== 'backups.download'
    setUp()
    renderBackups()

    const downloadButton = await screen.findByRole('button', { name: /download/i })
    expect(downloadButton).toBeDisabled()

    fireEvent.click(downloadButton)
    await waitFor(() => expect(downloadBackup).not.toHaveBeenCalled())
  })

  it('enables Download and a click calls downloadBackup when the role holds backups.download', async () => {
    mockCan = () => true
    setUp()
    renderBackups()

    const downloadButton = await screen.findByRole('button', { name: /download/i })
    expect(downloadButton).not.toBeDisabled()

    fireEvent.click(downloadButton)
    await waitFor(() => expect(downloadBackup).toHaveBeenCalledWith(testBackup.name))
  })
})
