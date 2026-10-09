import { useMemo, useRef, useState } from 'react'
import { modsApi } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { createRequirementResolver } from '@/lib/modLoadOrder'
import type { ModEntry, WsGroup } from '@/lib/modsShared'
import { useConfirm } from '@/contexts/ConfirmContext'
import { notify, pairKey } from './modsShared'
import type { ConflictScan } from './useConflictScan'
import type { ModsData } from './useModsData'

/**
 * What the server config loads, grouped by Workshop item, with the problems the panel can see:
 * missing requirements, IDs two items both provide, and variants the scan found sharing files.
 */
export function useActiveMods(data: ModsData, scan: ConflictScan) {
  const { iniConfig, setIniConfig, setOrderedModIds, ignoredPairs, setIgnoredPairs, busyRef, refreshConfig } = data
  const confirm = useConfirm()
  const [lastSaved, setLastSaved] = useState<string | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const derived = useMemo(() => {
    const workshopMap = iniConfig?.workshopModMap || {}
    const groups: WsGroup[] = []
    for (const wsId of iniConfig?.workshopIds || []) {
      const mods = workshopMap[wsId] || []
      if (mods.length) groups.push({ wsId, mods, allEnabled: mods.every((mod) => mod.enabled), someEnabled: mods.some((mod) => mod.enabled) })
    }
    const all = groups.flatMap((group) => group.mods)
    const mapped = new Set(all.map((mod) => mod.id))
    const enabled = new Set(all.filter((mod) => mod.enabled).map((mod) => mod.id))
    // IDs in Mods= that no downloaded Workshop item provides.
    const orphaned = (iniConfig?.modIds || []).filter((id) => !mapped.has(id))
    for (const id of orphaned) enabled.add(id)

    const resolve = createRequirementResolver(enabled)
    const missingDeps = new Map<string, string[]>()
    for (const group of groups) {
      for (const mod of group.mods) {
        if (!mod.require?.length || !mod.enabled) continue
        const missing = mod.require.filter((requirement) => resolve(requirement) === null)
        if (missing.length) missingDeps.set(mod.id, missing)
      }
    }

    const providers = new Map<string, string[]>()
    for (const group of groups) for (const mod of group.mods) providers.set(mod.id, [...(providers.get(mod.id) || []), group.wsId])
    const duplicates = new Map([...providers].filter(([, wsIds]) => wsIds.length > 1))

    return { groups, orphaned, enabledCount: enabled.size, totalCount: all.length, multiIdCount: groups.filter((group) => group.mods.length > 1).length, missingDeps, duplicates }
  }, [iniConfig?.workshopModMap, iniConfig?.workshopIds, iniConfig?.modIds])

  const ignored = useMemo(() => new Set(ignoredPairs.map((pair) => pairKey(pair.mod_a, pair.mod_b))), [ignoredPairs])

  /** For each Workshop item, which of its own IDs the last scan found sharing files. */
  const siblings = useMemo(() => {
    const result = new Map<string, Map<string, Set<string>>>()
    if (!scan.conflicts?.pairs?.length) return result
    const owner = new Map<string, string>()
    for (const group of derived.groups) for (const mod of group.mods) owner.set(mod.id, group.wsId)
    for (const pair of scan.conflicts.pairs) {
      const a = pair.modA.modId
      const b = pair.modB.modId
      const wsId = owner.get(a)
      if (!wsId || wsId !== owner.get(b) || ignored.has(pairKey(a, b))) continue
      const byMod = result.get(wsId) ?? new Map<string, Set<string>>()
      byMod.set(a, (byMod.get(a) ?? new Set()).add(b))
      byMod.set(b, (byMod.get(b) ?? new Set()).add(a))
      result.set(wsId, byMod)
    }
    return result
  }, [scan.conflicts?.pairs, derived.groups, ignored])

  /** Enabled ID pairs inside one item that the scan says overwrite each other. */
  const clashingPairs = (group: WsGroup) => {
    const enabled = new Set(group.mods.filter((mod) => mod.enabled).map((mod) => mod.id))
    const seen = new Set<string>()
    const pairs: Array<[string, string]> = []
    for (const [modId, others] of siblings.get(group.wsId) ?? []) {
      if (!enabled.has(modId)) continue
      for (const other of others) {
        if (!enabled.has(other) || seen.has(pairKey(modId, other))) continue
        seen.add(pairKey(modId, other))
        pairs.push([modId, other])
      }
    }
    return pairs
  }

  const attention = (group: WsGroup) => {
    const clash = clashingPairs(group).length > 0
    const missing = group.mods.some((mod) => mod.enabled && (derived.missingDeps.get(mod.id)?.length ?? 0) > 0)
    const duplicate = group.mods.some((mod) => derived.duplicates.has(mod.id))
    return { clash, missing, duplicate, any: clash || missing || duplicate }
  }

  const flashSaved = (key: string) => {
    setLastSaved(key)
    if (savedTimer.current) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setLastSaved(null), 2000)
  }

  /** Writes ID toggles and updates the page in place, so the list doesn't jump while you work. */
  const applyToggles = async (wsId: string, changes: ModEntry[], on: boolean, failTitle: string) => {
    if (busyRef.current || changes.length === 0) return
    busyRef.current = true
    try {
      if (changes.length === 1) await modsApi.toggleModId(changes[0].id, on)
      else await modsApi.batchToggleModIds(changes.map((mod) => ({ modId: mod.id, enabled: on })))
      const ids = new Set(changes.map((mod) => mod.id))
      const apply = (list: string[]) => (on ? [...list, ...[...ids].filter((id) => !list.includes(id))] : list.filter((id) => !ids.has(id)))
      setIniConfig((prev) => {
        if (!prev) return prev
        const modIds = apply(prev.modIds)
        const workshopModMap = { ...prev.workshopModMap }
        if (workshopModMap[wsId]) workshopModMap[wsId] = workshopModMap[wsId].map((mod) => (ids.has(mod.id) ? { ...mod, enabled: on } : mod))
        return { ...prev, modIds, totalMods: modIds.length, workshopModMap }
      })
      setOrderedModIds((prev) => apply(prev))
      flashSaved(changes[0].id)
    } catch (error) {
      reportClientError(failTitle, error)
      notify(failTitle, undefined, 'error')
    } finally {
      busyRef.current = false
    }
  }

  const toggleMod = (mod: ModEntry, wsId: string) => applyToggles(wsId, [mod], !mod.enabled, "Couldn't change the mod ID")
  const toggleGroup = (group: WsGroup) => applyToggles(group.wsId, group.mods.filter((mod) => mod.enabled === group.allEnabled), !group.allEnabled, "Couldn't change the IDs")

  const dismissPair = async (a: string, b: string) => {
    try {
      await modsApi.addIgnoredModPair(a, b)
      const [first, second] = a < b ? [a, b] : [b, a]
      setIgnoredPairs((prev) => (prev.some((pair) => pair.mod_a === first && pair.mod_b === second) ? prev : [...prev, { mod_a: first, mod_b: second }]))
      notify('Marked as not a conflict', `${a} and ${b}`)
    } catch (error) {
      reportClientError('Failed to dismiss conflict', error)
      notify("Couldn't dismiss the conflict", undefined, 'error')
    }
  }

  const restorePair = async (a: string, b: string) => {
    try {
      await modsApi.removeIgnoredModPair(a, b)
      const [first, second] = a < b ? [a, b] : [b, a]
      setIgnoredPairs((prev) => prev.filter((pair) => !(pair.mod_a === first && pair.mod_b === second)))
    } catch (error) {
      reportClientError('Failed to restore conflict', error)
      notify("Couldn't restore the conflict", undefined, 'error')
    }
  }

  /** Takes a Workshop item and its IDs out of the server config. The panel keeps tracking it. */
  const removeFromConfig = async (group: WsGroup) => {
    const confirmed = await confirm({
      title: 'Take this item out of the server config?',
      description: 'The Workshop item and its mod IDs come out of the config, so the server stops loading it. The files stay on disk, and the panel keeps tracking it.',
      confirmLabel: 'Take it out',
      destructive: true,
    })
    if (!confirmed) return
    try {
      await modsApi.removeFromIni(group.wsId, undefined, group.mods.map((mod) => mod.id))
      await refreshConfig()
      flashSaved(`removed-${group.wsId}`)
    } catch (error) {
      reportClientError('Failed to remove workshop item', error)
      notify("Couldn't take it out", undefined, 'error')
    }
  }

  const removeOrphan = async (id: string) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      await modsApi.toggleModId(id, false)
      await refreshConfig()
    } catch (error) {
      reportClientError('Failed to remove orphaned mod', error)
      notify("Couldn't remove the ID", undefined, 'error')
    } finally {
      busyRef.current = false
    }
  }

  const groupLabel = (group: WsGroup) => (group.mods[0].name !== group.mods[0].id ? group.mods[0].name : group.mods[0].id)

  return { ...derived, siblings, clashingPairs, attention, lastSaved, toggleMod, toggleGroup, dismissPair, restorePair, removeFromConfig, removeOrphan, groupLabel, ignoredPairs }
}

export type ActiveMods = ReturnType<typeof useActiveMods>
