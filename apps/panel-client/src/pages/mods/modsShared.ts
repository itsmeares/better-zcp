import { toastManager } from '@/components/ui/toast'

export interface IniConfig {
  configured: boolean
  modIds: string[]
  workshopIds: string[]
  maps: string[]
  totalMods: number
  iniPath?: string
  error?: string
  workshopModMap?: Record<string, Array<{ id: string; name: string; enabled: boolean; require?: string[] }>>
  duplicateKeys?: Array<{ key: string; count: number }>
}

export interface IgnoredMod {
  workshop_id: string
  name: string | null
  ignored_at: string
}

export interface IgnoredPair {
  mod_a: string
  mod_b: string
  reason?: string | null
}

export const workshopUrl = (workshopId: string) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${workshopId}`

export const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`

export function parseSteamCommunityUrl(input: string): URL | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`)
    if (url.protocol !== 'https:' || !['steamcommunity.com', 'www.steamcommunity.com'].includes(url.hostname.toLowerCase())) return null
    return url
  } catch {
    return null
  }
}

/** A Workshop ID from a bare number or a steamcommunity.com link. */
export function parseWorkshopId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const numeric = trimmed.match(/^(\d{6,15})$/)
  if (numeric) return numeric[1]
  const id = parseSteamCommunityUrl(trimmed)?.searchParams.get('id')
  return id && /^\d{1,15}$/.test(id) ? id : null
}

type Tone = 'success' | 'error' | 'warning' | 'info'

/** Every Mods toast goes through here so wording and timing stay consistent. */
export function notify(title: string, description?: string, type: Tone | undefined = undefined) {
  toastManager.add({ title, description, type })
}

/** The order-independent key for a pair of mod IDs. */
export const pairKey = (a: string, b: string) => (a < b ? `${a}--${b}` : `${b}--${a}`)
