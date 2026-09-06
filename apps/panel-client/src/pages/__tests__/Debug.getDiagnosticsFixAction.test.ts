import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { getDiagnosticsFixAction } from '../Debug'

const t = ((key: string) => key) as unknown as TFunction

function fallbackCheck(overrides: Partial<{
  id: string
  status: 'ok' | 'warn' | 'fail' | 'info' | 'skip'
  category: string
  hint: string
  meta: {
    unresolvedMods?: string[]
    unresolvedTriage?: Array<{ modId: string; cause: string; suggestion?: string }>
  }
}>) {
  return {
    id: 'some.unregistered.check',
    label: 'Some check',
    status: 'fail' as const,
    severity: 'critical' as const,
    message: 'Some message.',
    category: 'services',
    ...overrides,
  }
}

describe('getDiagnosticsFixAction fallback branch (uncovered check ids)', () => {
  it('routes unresolved Mods= entries to the exact editable Server Config field', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({
        id: 'mods.resolved',
        hint: 'Fix in server.ini.',
        meta: { unresolvedMods: ['ArcadiaQOLSafehouse_B42'] },
      }),
      t,
    )
    expect(action).toMatchObject({
      automated: false,
      manualRoute: '/server-config?tab=ini&search=Mods&unresolved=ArcadiaQOLSafehouse_B42',
    })
    expect(action?.openServerConfig).toBeUndefined()
    expect(action?.links).toBeUndefined()
  })

  it('carries the server-computed per-ID triage into the deep-link querystring', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({
        id: 'mods.resolved',
        hint: 'Fix in server.ini.',
        meta: {
          unresolvedMods: ['Footprnt', 'Quartermaster'],
          unresolvedTriage: [
            { modId: 'Footprnt', cause: 'typo', suggestion: 'Footprint' },
            { modId: 'Quartermaster', cause: 'stillDownloading' },
          ],
        },
      }),
      t,
    )
    expect(action?.manualRoute).toBe(
      '/server-config?tab=ini&search=Mods&unresolved=Footprnt&unresolved=Quartermaster'
        + '&unresolvedCause=Footprnt%7Ctypo%7CFootprint&unresolvedCause=Quartermaster%7CstillDownloading%7C',
    )
  })

  it('drops an unrecognized triage cause instead of forwarding it verbatim', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({
        id: 'mods.resolved',
        hint: 'Fix in server.ini.',
        meta: {
          unresolvedMods: ['SomeMod'],
          unresolvedTriage: [{ modId: 'SomeMod', cause: 'somethingNewTheServerAdded' }],
        },
      }),
      t,
    )
    expect(action?.manualRoute).toBe('/server-config?tab=ini&search=Mods&unresolved=SomeMod')
  })

  it.each(['server.active', 'server.installPath'])(
    '%s navigates via its own manualRoute instead of a redundant duplicate "Open Servers" link',
    (id) => {
      const action = getDiagnosticsFixAction(fallbackCheck({ id, category: 'server' }), t)
      expect(action?.manualRoute).toBe('/servers')
      expect(action?.links).toEqual([{ to: '/server-finder', label: 'fixActions.links.autoDetect' }])
    },
  )

  const manualRouteFixes: Array<{
    ids: string[]
    manualRoute: string
    links?: Array<{ to: string; label: string }>
    openServerConfig?: boolean
    openMods?: boolean
  }> = [
    { ids: ['mods.workshopCrash'], manualRoute: '/mods' },
    { ids: ['server.zomboidData'], manualRoute: '/settings' },
    { ids: ['server.startScript', 'server.jre', 'server.jreWorks'], manualRoute: '/server-finder' },
    { ids: ['server.ini'], manualRoute: '/server-config' },
    {
      ids: ['server.rconPassword'],
      manualRoute: '/server-config',
      links: [{ to: '/settings', label: 'fixActions.links.openSettings' }],
    },
    { ids: ['server.bridgeMod'], manualRoute: '/server-finder' },
    { ids: ['server.configDrift'], manualRoute: '/server-config' },
    { ids: ['scheduler', 'services.error'], manualRoute: '/settings' },
    { ids: ['bridge.writable', 'bridge.heartbeat'], manualRoute: '/server-finder' },
    { ids: ['db.exists'], manualRoute: '/settings' },
    { ids: ['logs.writable'], manualRoute: '/settings' },
    {
      ids: ['disk.free'],
      manualRoute: '/backups',
      links: [{ to: '/chunks', label: 'fixActions.links.openChunkCleaner' }],
    },
    { ids: ['storage.saveSize'], manualRoute: '/chunks' },
    { ids: ['runtime.heap', 'runtime.hostMem'], manualRoute: '/settings' },
    { ids: ['update.panel', 'updates.error'], manualRoute: '/settings' },
    { ids: ['update.mods'], manualRoute: '/mods' },
  ]

  for (const fix of manualRouteFixes) {
    it.each(fix.ids)(
      `%s navigates via manualRoute "${fix.manualRoute}" with no leftover duplicate link/flag`,
      (id) => {
        const action = getDiagnosticsFixAction(fallbackCheck({ id, category: 'server' }), t)
        expect(action?.automated).toBe(false)
        expect(action?.manualRoute).toBe(fix.manualRoute)
        expect(action?.links).toEqual(fix.links)
        expect(action?.openServerConfig).toBeUndefined()
        expect(action?.openMods).toBeUndefined()
      },
    )
  }

  it('opens server config when the hint contains the literal server.ini token', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Edit server.ini to fix this.' }),
      t,
    )
    expect(action?.openServerConfig).toBe(true)
  })

  it('does NOT open server config for translated prose that would have matched the old English phrase', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Öffne die Serverkonfiguration, um dies zu beheben.' }),
      t,
    )
    expect(action?.openServerConfig).toBe(false)
  })

  it('does NOT open server config for the English prose phrase alone, without the literal token', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Open server config to fix this.' }),
      t,
    )
    expect(action?.openServerConfig).toBe(false)
  })

  it('opens mods when the hint contains the literal Mods= token', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Remove the entry from Mods= and retry.' }),
      t,
    )
    expect(action?.openMods).toBe(true)
  })

  it('is case-insensitive for the literal tokens (hint is lowercased before matching)', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Check SERVER.INI for a stray entry.' }),
      t,
    )
    expect(action?.openServerConfig).toBe(true)
  })

  it('returns neither flag when the hint matches nothing', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Restart the panel and try again.' }),
      t,
    )
    expect(action?.openServerConfig).toBe(false)
    expect(action?.openMods).toBe(false)
  })

  it('returns null for a passing or skipped check regardless of hint content', () => {
    expect(
      getDiagnosticsFixAction(
        fallbackCheck({ status: 'ok', hint: 'server.ini' }),
        t,
      ),
    ).toBeNull()
    expect(
      getDiagnosticsFixAction(
        fallbackCheck({ status: 'skip', hint: 'server.ini' }),
        t,
      ),
    ).toBeNull()
  })

  it('returns null for an info-status check with no explicit switch case', () => {
    expect(
      getDiagnosticsFixAction(fallbackCheck({ status: 'info' }), t),
    ).toBeNull()
  })
})

function manyIds(n: number) {
  return Array.from({ length: n }, (_, i) => String(i + 1))
}

describe('getDiagnosticsFixAction -- confirm/destructive pairing', () => {
  it('server.staleLocks always confirms and is destructive (it deletes files)', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ id: 'server.staleLocks', category: 'server' }),
      t,
    )
    expect(action?.confirm).toBeDefined()
    expect(action?.confirm?.destructive).toBe(true)
  })

  it('mods.numericInMods only confirms above the 10-item threshold, and is never destructive (an INI toggle)', () => {
    const few = getDiagnosticsFixAction(
      {
        ...fallbackCheck({ id: 'mods.numericInMods', category: 'mods' }),
        meta: { numericInMods: manyIds(3) },
      },
      t,
    )
    expect(few?.confirm).toBeUndefined()

    const many = getDiagnosticsFixAction(
      {
        ...fallbackCheck({ id: 'mods.numericInMods', category: 'mods' }),
        meta: { numericInMods: manyIds(11) },
      },
      t,
    )
    expect(many?.confirm).toBeDefined()
    expect(many?.confirm?.destructive).toBe(false)
  })

  it('mods.orphanWorkshop only confirms above the 10-item threshold, and is never destructive (an INI toggle)', () => {
    const few = getDiagnosticsFixAction(
      {
        ...fallbackCheck({ id: 'mods.orphanWorkshop', category: 'mods' }),
        meta: { orphanWorkshop: manyIds(3) },
      },
      t,
    )
    expect(few?.confirm).toBeUndefined()

    const many = getDiagnosticsFixAction(
      {
        ...fallbackCheck({ id: 'mods.orphanWorkshop', category: 'mods' }),
        meta: { orphanWorkshop: manyIds(11) },
      },
      t,
    )
    expect(many?.confirm).toBeDefined()
    expect(many?.confirm?.destructive).toBe(false)
  })

  it('automated fixes that never ask for confirmation carry no confirm object at all', () => {
    for (const id of ['mods.maps', 'mods.duplicates', 'server.process', 'rcon.connected', 'db.backup']) {
      const action = getDiagnosticsFixAction(fallbackCheck({ id, category: 'server' }), t)
      expect(action?.automated).toBe(true)
      expect(action?.confirm).toBeUndefined()
    }
  })
})
