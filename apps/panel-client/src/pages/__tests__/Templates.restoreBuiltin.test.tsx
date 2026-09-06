import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Templates from '../Templates'
import { templatesApi, SimTemplate } from '@/lib/api'


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
    templatesApi: {
      ...actual.templatesApi,
      list: vi.fn(),
      listHidden: vi.fn(),
      unhide: vi.fn(),
    },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const listTemplates = vi.mocked(templatesApi.list)
const listHidden = vi.mocked(templatesApi.listHidden)
const unhide = vi.mocked(templatesApi.unhide)

function makeHiddenBuiltin(overrides: Partial<SimTemplate> = {}): SimTemplate {
  return {
    schemaVersion: 1,
    meta: { id: 'vanilla-apocalypse', name: 'Vanilla Apocalypse', description: '', tags: [] },
    isBuiltin: true,
    difficulty: {},
    mods: [],
    serverIni: {},
    sandboxVars: {},
    iniExclusions: [],
    map: { mapId: 'Muldraugh, KY' },
    ...overrides,
  } as unknown as SimTemplate
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderTemplates() {
  return render(
    <MemoryRouter>
      <Templates />
    </MemoryRouter>,
  )
}

describe('Templates.tsx -- restoring a hidden built-in template', () => {
  it('renders a hidden built-in with a Restore action the operator can actually use', async () => {
    listTemplates.mockResolvedValue({ templates: [] })
    listHidden.mockResolvedValue({ templates: [makeHiddenBuiltin()] })

    renderTemplates()

    expect(await screen.findByText('Vanilla Apocalypse')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore Vanilla Apocalypse' })).toBeInTheDocument()
  })

  it('does not render the hidden section at all when nothing is hidden', async () => {
    listTemplates.mockResolvedValue({ templates: [] })
    listHidden.mockResolvedValue({ templates: [] })

    renderTemplates()

    await screen.findByText('Simulation Templates')
    expect(screen.queryByText('Hidden built-in templates')).not.toBeInTheDocument()
  })

  it('restoring calls unhide with the right id, refetches both lists, and toasts success', async () => {
    listTemplates.mockResolvedValue({ templates: [] })
    listHidden.mockResolvedValueOnce({ templates: [makeHiddenBuiltin()] })
    unhide.mockResolvedValue({ success: true })
    listHidden.mockResolvedValueOnce({ templates: [] })

    renderTemplates()
    const restoreButton = await screen.findByRole('button', { name: 'Restore Vanilla Apocalypse' })
    restoreButton.click()

    await waitFor(() => expect(unhide).toHaveBeenCalledWith('vanilla-apocalypse'))
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Template Restored' }),
      ),
    )
    await waitFor(() => expect(listHidden).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Restore Vanilla Apocalypse' })).not.toBeInTheDocument(),
    )
  })

  it('reports a failed restore without silently dropping the error', async () => {
    listTemplates.mockResolvedValue({ templates: [] })
    listHidden.mockResolvedValue({ templates: [makeHiddenBuiltin()] })
    unhide.mockResolvedValue({ success: false, error: 'Template not found' })

    renderTemplates()
    const restoreButton = await screen.findByRole('button', { name: 'Restore Vanilla Apocalypse' })
    restoreButton.click()

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Restore Failed', variant: 'destructive' }),
      ),
    )
    expect(screen.getByRole('button', { name: 'Restore Vanilla Apocalypse' })).toBeInTheDocument()
  })
})
