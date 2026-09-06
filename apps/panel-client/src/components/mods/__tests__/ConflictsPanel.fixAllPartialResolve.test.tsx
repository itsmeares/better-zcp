import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConflictsPanel } from '../ConflictsPanel'
import { modsApi } from '@/lib/api'
import type { DepSearchState } from '@/lib/modsShared'
import type { ConflictScanResult } from '@/types'

// regression (testing traced the server half, the slice for the
// client half): handleFixAll used to mark EVERY requested row 'added' the
// instant POST /add-all-resolved-deps resolved without throwing, ignoring
// that each row's own workshop-add can succeed while its Mod ID resolution
// (a best-effort Steam description scrape) fails -- leaving that dependency
// subscribed but never loading. Concrete failure this locks in: 2 missing
// deps, the server resolves both workshop adds but only one real Mod ID.
// The client must NOT turn the unresolved one green. See
// apps/panel-server/tests/modsAddAllResolvedDepsResultsShape.test.js for the server
// half of this same fix, and this file's handleAddDep (the single-row "Add"
// button) for the identical shape found and fixed on the same pass.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    modsApi: {
      ...actual.modsApi,
      addAllResolvedDeps: vi.fn(),
      addMissingDep: vi.fn(),
    },
  }
})

const addAllResolvedDeps = vi.mocked(modsApi.addAllResolvedDeps)
const addMissingDep = vi.mocked(modsApi.addMissingDep)

const baseConflicts: ConflictScanResult = {
  totalConflicts: 0,
  identicalSkipped: 0,
  pairs: [],
  totalPairs: 0,
  modsScanned: 0,
  missingDeps: [],
  steamDeps: [
    { parentWorkshopId: 'P1', parentName: 'Parent Mod A', childWorkshopId: 'WS-RESOLVED', childName: 'Resolvable Dep', source: 'steam' },
    { parentWorkshopId: 'P2', parentName: 'Parent Mod B', childWorkshopId: 'WS-UNRESOLVED', childName: 'Unresolvable Dep', source: 'steam' },
  ],
  modLoadOrder: [],
}

function noop() {}

// ConflictsPanel is a controlled component -- depAddResults/depAdding/
// depSearchOpen/depSearchData are all owned by its caller (Mods.tsx in the
// real app). A no-op setter would silently swallow every state update
// handleFixAll/handleAddDep make, which is not what this test wants to
// exercise -- so this harness gives them real useState, the same as Mods.tsx
// itself does, rather than stubbing the setters out.
function Harness() {
  const [depSearchOpen, setDepSearchOpen] = useState(new Set<string>())
  const [depSearchData, setDepSearchData] = useState<Record<string, DepSearchState>>({})
  const [depAdding, setDepAdding] = useState<string[]>([])
  const [depAddResults, setDepAddResults] = useState<Record<string, 'added' | 'error'>>({})

  return (
    <TooltipProvider>
      <ConflictsPanel
        conflicts={baseConflicts}
        conflictsLoading={false}
        conflictsError={null}
        conflictsStale={false}
        lastScanTime={null}
        scanConflicts={noop}
        scanProgress={0}
        scanCurrentMod={null}
        scanModsScanned={0}
        scanTotalMods={0}
        streamConflicts={[]}
        focusDependencies
        fetchData={noop}
        busyRef={{ current: false }}
        savingModOrder={false}
        promoteModOverOpponent={async () => {}}
        toast={noop}
        depSearchOpen={depSearchOpen}
        setDepSearchOpen={setDepSearchOpen}
        depSearchData={depSearchData}
        setDepSearchData={setDepSearchData}
        depAdding={depAdding}
        setDepAdding={setDepAdding}
        depAddResults={depAddResults}
        setDepAddResults={setDepAddResults}
      />
    </TooltipProvider>
  )
}

function renderPanel() {
  return render(<Harness />)
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ConflictsPanel: Fix All only marks a row added when its own result confirms a real Mod ID', () => {
  it('marks the resolved dep Added and the unresolved dep Failed, not both Added', async () => {
    addAllResolvedDeps.mockResolvedValue({
      success: true,
      total: 2,
      wsAdded: 2,
      modIdsAdded: 1,
      mapFolders: [],
      message: 'Added 2 dependencies to server config.',
      results: [
        { workshopId: 'WS-RESOLVED', modId: 'ResolvedModId', wsAdded: true, modIdAdded: true },
        { workshopId: 'WS-UNRESOLVED', modId: null, wsAdded: true, modIdAdded: false },
      ],
    })

    renderPanel()

    const fixAllButton = await screen.findByRole('button', { name: /add resolved/i })
    fireEvent.click(fixAllButton)

    await waitFor(() => expect(addAllResolvedDeps).toHaveBeenCalledTimes(1))

    // Exactly one "Added" -- the resolved dep -- and the unresolved dep
    // reads Failed, never a second Added.
    await waitFor(() => expect(screen.getAllByText('Added')).toHaveLength(1))
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })

  it('handleAddDep (the single-row Add button) has the identical fix: a null modId reads Failed, not Added', async () => {
    addMissingDep.mockResolvedValue({
      success: true,
      workshopId: 'WS-UNRESOLVED',
      modId: null,
      wsAdded: true,
      modIdAdded: false,
      mapFolders: [],
      message: 'ok',
    })

    renderPanel()

    const addButtons = await screen.findAllByRole('button', { name: 'Add' })
    // Both rows start as steam-sourced with a known workshopId, so both get
    // a per-row Add button (not the Search Workshop fallback) -- click the
    // second one (Unresolvable Dep).
    fireEvent.click(addButtons[1])

    await waitFor(() => expect(addMissingDep).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('Failed')).toBeInTheDocument())
    expect(screen.queryByText('Added')).not.toBeInTheDocument()
  })
})
