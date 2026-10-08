import { useState } from 'react'
import { modsApi } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import type { DepSearchHit, DepSearchState } from '@/lib/modsShared'
import { notify } from './modsShared'
import type { ModsData } from './useModsData'

/**
 * Workshop searches for missing dependencies. Mod IDs and Conflicts share it, so a dependency
 * added in one shows as added in the other.
 */
export function useDepSearch(data: ModsData) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<Record<string, DepSearchState>>({})
  const [adding, setAdding] = useState<string[]>([])
  const [outcomes, setOutcomes] = useState<Record<string, 'added' | 'error'>>({})

  const search = async (key: string, query: string, parent: { parentName?: string; parentWorkshopId?: string }, force = false) => {
    if (!force && results[key] && !results[key].error) return
    setResults((prev) => ({ ...prev, [key]: { loading: true, results: [], error: null, searchUrl: null } }))
    try {
      const response = await modsApi.searchWorkshopMods(query, parent)
      setResults((prev) => ({
        ...prev,
        [key]: { loading: false, results: response.results || [], error: null, searchUrl: response.searchUrl, variantsTried: response.variantsTried, steamSearchEnabled: response.steamSearchEnabled },
      }))
    } catch (error) {
      setResults((prev) => ({ ...prev, [key]: { loading: false, results: [], error: getUserErrorMessage(error, 'Search failed'), searchUrl: null } }))
    }
  }

  const toggle = (key: string, query: string, parent: { parentName?: string; parentWorkshopId?: string }) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (!results[key]) void search(key, query, parent)
  }

  const add = async (hit: DepSearchHit, dep: string, key: string) => {
    if (data.busyRef.current) return
    data.busyRef.current = true
    setAdding((prev) => [...prev, key])
    try {
      await modsApi.addMissingDep(hit.workshopId, hit.modId || dep)
      setOutcomes((prev) => ({ ...prev, [key]: 'added' }))
      await data.refreshConfig()
      notify('Dependency added', `${hit.modName} is in the server config.`, 'success')
    } catch (error) {
      reportClientError('Failed to add dependency.', error)
      setOutcomes((prev) => ({ ...prev, [key]: 'error' }))
      notify("Couldn't add it", getUserErrorMessage(error, 'Try again.'), 'error')
    } finally {
      setAdding((prev) => prev.filter((item) => item !== key))
      data.busyRef.current = false
    }
  }

  return { open, setOpen, results, setResults, adding, setAdding, outcomes, setOutcomes, search, toggle, add }
}

export type DepSearch = ReturnType<typeof useDepSearch>
