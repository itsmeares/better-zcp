import { describe, it, expect } from 'vitest'
import { buildRequiresMap, computeAutoSortedOrder, createRequirementResolver } from '../modLoadOrder'

const requires = (entries: Record<string, string[]>) => new Map(Object.entries(entries))

describe('computeAutoSortedOrder', () => {
  it('leaves an order untouched when no dependencies are declared', () => {
    const result = computeAutoSortedOrder(['B', 'A', 'C'], new Map())

    expect(result.order).toEqual(['B', 'A', 'C'])
    expect(result.moved).toEqual([])
    expect(result.appliedEdges).toBe(0)
  })

  it('moves a required library ahead of the mod that requires it', () => {
    const result = computeAutoSortedOrder(
      ['Overhaul', 'BaseLibrary'],
      requires({ Overhaul: ['BaseLibrary'] }),
    )

    expect(result.order).toEqual(['BaseLibrary', 'Overhaul'])
    expect(result.appliedEdges).toBe(1)
    // With only two mods either one can be called "the one that moved"; the
    // report describes the library being pulled above the mod requiring it.
    expect(result.moved).toEqual([{ modId: 'BaseLibrary', from: 2, to: 1 }])
  })

  it('only moves the dependent mod and keeps every other mod in relative order', () => {
    const result = computeAutoSortedOrder(
      ['Zed', 'Overhaul', 'Alpha', 'BaseLibrary'],
      requires({ Overhaul: ['BaseLibrary'] }),
    )

    // Zed / Alpha / BaseLibrary keep their relative order; only Overhaul is
    // pushed past the library it requires.
    expect(result.order).toEqual(['Zed', 'Alpha', 'BaseLibrary', 'Overhaul'])
    expect(result.moved).toEqual([{ modId: 'Overhaul', from: 2, to: 4 }])
  })

  it('does not report mods that merely drift when a mod above them moves', () => {
    // Only Overhaul is constrained. A, B and C shift down by one index each,
    // but none of them actually changed position relative to the others.
    const result = computeAutoSortedOrder(
      ['Overhaul', 'A', 'B', 'C', 'BaseLibrary'],
      requires({ Overhaul: ['BaseLibrary'] }),
    )

    expect(result.order).toEqual(['A', 'B', 'C', 'BaseLibrary', 'Overhaul'])
    expect(result.moved).toEqual([{ modId: 'Overhaul', from: 1, to: 5 }])
  })

  it('is idempotent', () => {
    const deps = requires({ Overhaul: ['BaseLibrary'], Patch: ['Overhaul'] })
    const first = computeAutoSortedOrder(['Patch', 'Overhaul', 'BaseLibrary'], deps)
    const second = computeAutoSortedOrder(first.order, deps)

    expect(second.order).toEqual(first.order)
    expect(second.moved).toEqual([])
  })

  it('reports requirements that are not in the load order', () => {
    const result = computeAutoSortedOrder(['Overhaul'], requires({ Overhaul: ['NotEnabled'] }))

    expect(result.order).toEqual(['Overhaul'])
    expect(result.missing).toEqual([{ modId: 'Overhaul', requires: 'NotEnabled' }])
  })

  it('keeps cyclic mods instead of dropping them, and reports them as one group', () => {
    const result = computeAutoSortedOrder(
      ['A', 'B', 'C'],
      requires({ A: ['B'], B: ['A'] }),
    )

    expect(result.order.slice().sort()).toEqual(['A', 'B', 'C'])
    expect(result.cycles).toEqual([['A', 'B']])
  })

  it('reports independent cycles separately instead of as one blob', () => {
    const result = computeAutoSortedOrder(
      ['A', 'B', 'C', 'D'],
      requires({ A: ['B'], B: ['A'], C: ['D'], D: ['C'] }),
    )

    expect(result.cycles).toEqual([['A', 'B'], ['C', 'D']])
  })

  it('still orders a mod that depends on a mod caught in a cycle', () => {
    // Patch -> A is perfectly satisfiable even though A and B require each
    // other, so Patch must still be moved below A.
    const result = computeAutoSortedOrder(
      ['Patch', 'A', 'B'],
      requires({ A: ['B'], B: ['A'], Patch: ['A'] }),
    )

    expect(result.order.indexOf('A')).toBeLessThan(result.order.indexOf('Patch'))
    expect(result.cycles).toEqual([['A', 'B']])
  })

  it('ignores self-requirements and duplicate entries', () => {
    const result = computeAutoSortedOrder(
      ['A', 'B'],
      requires({ A: ['A'], B: ['A', 'A'] }),
    )

    expect(result.order).toEqual(['A', 'B'])
    expect(result.appliedEdges).toBe(1)
  })

  it('orders against a fork that satisfies the requirement instead of calling it missing', () => {
    // The Conflicts tab already treats "BaseLibrary_Refactor" as satisfying
    // "require=BaseLibrary"; the sort has to agree and order against it.
    const result = computeAutoSortedOrder(
      ['Overhaul', 'BaseLibrary_Refactor'],
      requires({ Overhaul: ['BaseLibrary'] }),
    )

    expect(result.order).toEqual(['BaseLibrary_Refactor', 'Overhaul'])
    expect(result.appliedEdges).toBe(1)
    expect(result.missing).toEqual([])
  })

  it('trims padded requirement entries and reports each one once', () => {
    const result = computeAutoSortedOrder(
      ['Overhaul', 'BaseLibrary'],
      requires({ Overhaul: [' BaseLibrary ', '', '  ', 'NotEnabled', 'NotEnabled '] }),
    )

    expect(result.order).toEqual(['BaseLibrary', 'Overhaul'])
    expect(result.appliedEdges).toBe(1)
    expect(result.missing).toEqual([{ modId: 'Overhaul', requires: 'NotEnabled' }])
  })

  describe('longestIncreasingSubsequence / stronglyConnectedComponents audit (2026-08-31)', () => {
    // Prior coverage only exercised 2-node cycles and a single mod depending
    // on one cycle. Every result below was hand-verified against a manual
    // topological trace before being pinned -- see the audit report to god
    // for the full by-hand derivation. No defect found in either function;
    // these close a real coverage gap rather than fix a bug.

    it('breaks a 3-node cycle as one group and leaves the order untouched', () => {
      const result = computeAutoSortedOrder(['A', 'B', 'C'], requires({ A: ['B'], B: ['C'], C: ['A'] }))

      expect(result.order).toEqual(['A', 'B', 'C'])
      expect(result.cycles).toEqual([['A', 'B', 'C']])
      expect(result.moved).toEqual([])
    })

    it('keeps two cycles as separate SCCs while still enforcing a real edge between them', () => {
      // cycle1={A,B}, cycle2={C,D}; B also genuinely requires C, so some
      // member of cycle2 must land before some member of cycle1 even though
      // neither cycle's own internal edges can be honored.
      const result = computeAutoSortedOrder(
        ['A', 'B', 'C', 'D'],
        requires({ A: ['B'], B: ['A', 'C'], C: ['D'], D: ['C'] }),
      )

      expect(result.cycles).toEqual([['A', 'B'], ['C', 'D']])
      expect(result.order.indexOf('C')).toBeLessThan(result.order.indexOf('B'))
    })

    it('correctly counts down a dependent that requires two different members of the same cycle', () => {
      const result = computeAutoSortedOrder(
        ['Patch', 'A', 'B'],
        requires({ A: ['B'], B: ['A'], Patch: ['A', 'B'] }),
      )

      expect(result.order).toEqual(['A', 'B', 'Patch'])
      expect(result.cycles).toEqual([['A', 'B']])
    })

    it('resolves a diamond dependency (two independent paths to the same root) with no cycle', () => {
      const result = computeAutoSortedOrder(
        ['D', 'B', 'C', 'A'],
        requires({ D: ['B', 'C'], B: ['A'], C: ['A'] }),
      )

      expect(result.order).toEqual(['A', 'B', 'C', 'D'])
      expect(result.cycles).toEqual([])
    })

    it('handles a real-world-scale graph (171 mods) with a cycle threaded through far-apart mods, dropping nothing', () => {
      const ids = Array.from({ length: 171 }, (_, i) => `Mod${i}`)
      const reqs: Record<string, string[]> = {}
      for (let i = 20; i < ids.length; i++) reqs[ids[i]] = [ids[i - 20]]
      reqs[ids[5]] = [...(reqs[ids[5]] || []), ids[50]]
      reqs[ids[50]] = [...(reqs[ids[50]] || []), ids[80]]
      reqs[ids[80]] = [...(reqs[ids[80]] || []), ids[5]]

      const result = computeAutoSortedOrder(ids, requires(reqs))

      expect(result.order.slice().sort()).toEqual(ids.slice().sort())
      expect(result.order.length).toBe(171)
      expect(result.cycles).toEqual([['Mod5', 'Mod50', 'Mod80']])
    })
  })
})

describe('createRequirementResolver', () => {
  it('prefers an exact match over a fork', () => {
    const resolve = createRequirementResolver(['Base_Fork', 'Base'])

    expect(resolve('Base')).toBe('Base')
  })

  it('accepts underscore and dash forks case-insensitively', () => {
    const resolve = createRequirementResolver(['base_refactor', 'Other-Legacy'])

    expect(resolve('Base')).toBe('base_refactor')
    expect(resolve('other')).toBe('Other-Legacy')
  })

  it('does not treat an unrelated mod with a shared prefix as a fork', () => {
    const resolve = createRequirementResolver(['BaseLibraryExtra'])

    expect(resolve('BaseLibrary')).toBeNull()
  })

  it('returns null for blank requirements', () => {
    const resolve = createRequirementResolver(['A'])

    expect(resolve('   ')).toBeNull()
  })

  describe('case-sensitivity (2026-08-31 audit)', () => {
    // The operator asked whether auto-sort's logic is perfect. It wasn't:
    // the exact-match tier was case-SENSITIVE while the fork tier was
    // case-INSENSITIVE, so the literal same mod under a differently-cased
    // ID resolved to null/missing while a fork of it resolved fine -- the
    // strictest tier was, backwards, the least forgiving one. Proved by
    // executing the pre-fix function and reading the actual return value
    // before touching the fix: createRequirementResolver(['Footprint'])
    // ('footprint') returned null, while
    // createRequirementResolver(['Footprint_Legacy'])('footprint') returned
    // 'Footprint_Legacy' -- the real mod failed where its fork succeeded.
    it('resolves an exact match case-insensitively, same as the fork tier already did', () => {
      const resolve = createRequirementResolver(['Footprint'])

      expect(resolve('footprint')).toBe('Footprint')
      expect(resolve('FOOTPRINT')).toBe('Footprint')
    })

    it('no longer disagrees with the fork tier once case differs', () => {
      // Before the fix these returned null and 'Footprint_Legacy'
      // respectively -- the real mod failing where its fork succeeded.
      const exactResolve = createRequirementResolver(['Footprint'])
      const forkResolve = createRequirementResolver(['Footprint_Legacy'])

      expect(exactResolve('footprint')).toBe('Footprint')
      expect(forkResolve('footprint')).toBe('Footprint_Legacy')
    })

    it('still prefers a case-sensitive exact match over a case-insensitive one', () => {
      // Two installed mods differing only by case is unusual but not
      // impossible (two independent workshop items with the same
      // human-typed mod.info id) -- the exact-case entry must still win
      // over falling back to the case-insensitive lookup, and the choice
      // must not depend on iteration/insertion order for the SAME id.
      const resolve = createRequirementResolver(['base', 'Base'])

      expect(resolve('Base')).toBe('Base')
      expect(resolve('base')).toBe('base')
    })

    it('picks the earliest-listed mod, deterministically, when only case-insensitive matches exist', () => {
      const resolve = createRequirementResolver(['Base', 'BASE'])

      expect(resolve('base')).toBe('Base')
    })
  })

  describe('fork false-positive risk (2026-08-31 audit, documented not fixed -- deliberate, out of scope)', () => {
    // god asked whether a requirement can invent an edge to an unrelated
    // mod that merely shares the underscore-fork naming convention. It can,
    // and this is reachable with real data: any two independent workshop
    // mods where one's ID is "<the other's declared requirement>_<anything>"
    // trigger it, with no way for the heuristic to tell a genuine fork from
    // a coincidence from the ID string alone. Changing this is explicitly
    // out of scope (the fork heuristic's intent is deliberate and already
    // tested above) -- this pins the risk as real rather than theoretical,
    // so nobody has to re-derive it from the algorithm's shape again.
    it('resolves a requirement against an unrelated mod that happens to share the fork naming convention', () => {
      const resolve = createRequirementResolver(['Armor_Unrelated'])

      expect(resolve('Armor')).toBe('Armor_Unrelated')
    })
  })
})

describe('buildRequiresMap', () => {
  it('collects requirements from the workshop mod map', () => {
    const map = buildRequiresMap({
      '111': [{ id: 'Overhaul', require: ['BaseLibrary'] }, { id: 'NoDeps' }],
      '222': [{ id: 'BaseLibrary' }],
    })

    expect(map.get('Overhaul')).toEqual(['BaseLibrary'])
    expect(map.has('NoDeps')).toBe(false)
    expect(map.has('BaseLibrary')).toBe(false)
  })

  it('merges requirements when a mod ID appears under several workshop items', () => {
    const map = buildRequiresMap({
      '111': [{ id: 'Overhaul', require: ['A'] }],
      '222': [{ id: 'Overhaul', require: ['B'] }],
    })

    expect(map.get('Overhaul')).toEqual(['A', 'B'])
  })

  it('handles a missing workshop map', () => {
    expect(buildRequiresMap(undefined).size).toBe(0)
  })
})
