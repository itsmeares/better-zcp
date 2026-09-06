
export interface AutoSortResult {
  order: string[]
  moved: Array<{ modId: string; from: number; to: number }>
  appliedEdges: number
  cycles: string[][]
  missing: Array<{ modId: string; requires: string }>
}

export function createRequirementResolver(
  modIds: Iterable<string>,
): (requirement: string) => string | null {
  const exact = new Set<string>()
  const exactByLower = new Map<string, string>()
  const lowerById: Array<[string, string]> = []
  for (const modId of modIds) {
    if (!modId || exact.has(modId)) continue
    exact.add(modId)
    const lower = modId.toLowerCase()
    if (!exactByLower.has(lower)) exactByLower.set(lower, modId)
    lowerById.push([modId, lower])
  }

  const cache = new Map<string, string | null>()
  return (requirement: string): string | null => {
    const needle = requirement?.trim()
    if (!needle) return null
    const cached = cache.get(needle)
    if (cached !== undefined) return cached

    let resolved: string | null = null
    if (exact.has(needle)) {
      resolved = needle
    } else {
      const prefix = needle.toLowerCase()
      const caseInsensitiveExact = exactByLower.get(prefix)
      if (caseInsensitiveExact) {
        resolved = caseInsensitiveExact
      } else {
        for (const [modId, lower] of lowerById) {
          if (lower.startsWith(prefix + '_') || lower.startsWith(prefix + '-')) {
            resolved = modId
            break
          }
        }
      }
    }
    cache.set(needle, resolved)
    return resolved
  }
}

export function computeAutoSortedOrder(
  modIds: string[],
  requiresByModId: Map<string, string[]>,
): AutoSortResult {
  const order: string[] = []
  const indexOf = new Map<string, number>()
  for (const modId of modIds) {
    if (indexOf.has(modId)) continue
    indexOf.set(modId, order.length)
    order.push(modId)
  }

  const resolve = createRequirementResolver(order)
  const indexOfMod = (modId: string) => indexOf.get(modId) ?? 0

  const dependents = new Map<string, string[]>()
  const missing: AutoSortResult['missing'] = []
  let appliedEdges = 0

  for (const modId of order) {
    const seenDependencies = new Set<string>()
    const reportedMissing = new Set<string>()
    for (const declared of requiresByModId.get(modId) || []) {
      const requirement = declared?.trim()
      if (!requirement) continue

      const dependency = resolve(requirement)
      if (!dependency) {
        if (reportedMissing.has(requirement)) continue
        reportedMissing.add(requirement)
        missing.push({ modId, requires: requirement })
        continue
      }

      if (dependency === modId || seenDependencies.has(dependency)) continue
      seenDependencies.add(dependency)

      const list = dependents.get(dependency)
      if (list) list.push(modId)
      else dependents.set(dependency, [modId])
      appliedEdges++
    }
  }

  const cycles = stronglyConnectedComponents(order, dependents)
    .filter((component) => component.length > 1)
    .map((component) => component.sort((a, b) => indexOfMod(a) - indexOfMod(b)))
    .sort((a, b) => indexOfMod(a[0]) - indexOfMod(b[0]))
  const cycleOf = new Map<string, number>()
  cycles.forEach((group, groupIndex) => {
    for (const modId of group) cycleOf.set(modId, groupIndex)
  })

  const remainingDeps = new Map<string, number>()
  for (const modId of order) remainingDeps.set(modId, 0)
  const unlocks = new Map<string, string[]>()
  for (const [dependency, list] of dependents) {
    for (const dependent of list) {
      const cycle = cycleOf.get(dependency)
      if (cycle !== undefined && cycle === cycleOf.get(dependent)) continue
      const existing = unlocks.get(dependency)
      if (existing) existing.push(dependent)
      else unlocks.set(dependency, [dependent])
      remainingDeps.set(dependent, (remainingDeps.get(dependent) ?? 0) + 1)
    }
  }

  const ready = order.filter((modId) => (remainingDeps.get(modId) ?? 0) === 0)
  const byIndex = (a: string, b: string) => indexOfMod(a) - indexOfMod(b)
  ready.sort(byIndex)

  const finalOrder: string[] = []
  while (ready.length > 0) {
    const modId = ready.shift() as string
    finalOrder.push(modId)

    let unlocked = false
    for (const dependent of unlocks.get(modId) || []) {
      const left = (remainingDeps.get(dependent) ?? 0) - 1
      remainingDeps.set(dependent, left)
      if (left === 0) {
        ready.push(dependent)
        unlocked = true
      }
    }
    if (unlocked) ready.sort(byIndex)
  }

  const originalIndices = finalOrder.map((modId) => indexOf.get(modId) as number)
  const stayed = longestIncreasingSubsequence(originalIndices)
  const moved: AutoSortResult['moved'] = []
  finalOrder.forEach((modId, index) => {
    if (stayed.has(index)) return
    moved.push({ modId, from: (indexOf.get(modId) as number) + 1, to: index + 1 })
  })

  return { order: finalOrder, moved, appliedEdges, cycles, missing }
}

function longestIncreasingSubsequence(values: number[]): Set<number> {
  const tails: number[] = []
  const previous = new Array<number>(values.length).fill(-1)

  for (let i = 0; i < values.length; i++) {
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (values[tails[mid]] < values[i]) low = mid + 1
      else high = mid
    }
    if (low > 0) previous[i] = tails[low - 1]
    tails[low] = i
  }

  const result = new Set<number>()
  let cursor = tails.length > 0 ? tails[tails.length - 1] : -1
  while (cursor !== -1) {
    result.add(cursor)
    cursor = previous[cursor]
  }
  return result
}

function stronglyConnectedComponents(
  nodes: string[],
  edges: Map<string, string[]>,
): string[][] {
  const index = new Map<string, number>()
  const lowLink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  const visit = (node: string) => {
    index.set(node, counter)
    lowLink.set(node, counter)
    counter++
    stack.push(node)
    onStack.add(node)
  }

  for (const root of nodes) {
    if (index.has(root)) continue
    visit(root)
    const frames = [{ node: root, successors: edges.get(root) || [], cursor: 0 }]

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]

      if (frame.cursor < frame.successors.length) {
        const next = frame.successors[frame.cursor++]
        if (!index.has(next)) {
          visit(next)
          frames.push({ node: next, successors: edges.get(next) || [], cursor: 0 })
        } else if (onStack.has(next)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node) as number, index.get(next) as number))
        }
        continue
      }

      frames.pop()
      if (lowLink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = []
        for (;;) {
          const member = stack.pop() as string
          onStack.delete(member)
          component.push(member)
          if (member === frame.node) break
        }
        components.push(component)
      }

      const parent = frames[frames.length - 1]
      if (parent) {
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node) as number, lowLink.get(frame.node) as number))
      }
    }
  }

  return components
}

export function buildRequiresMap(
  workshopModMap: Record<string, Array<{ id: string; require?: string[] }>> | undefined,
): Map<string, string[]> {
  const requires = new Map<string, string[]>()
  for (const entries of Object.values(workshopModMap || {})) {
    for (const entry of entries) {
      if (!entry?.id || !entry.require?.length) continue
      const existing = requires.get(entry.id)
      if (existing) requires.set(entry.id, [...existing, ...entry.require])
      else requires.set(entry.id, [...entry.require])
    }
  }
  return requires
}
