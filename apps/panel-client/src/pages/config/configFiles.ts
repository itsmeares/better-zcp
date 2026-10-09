import type { SandboxData } from '@/lib/api'
import { INI_SCHEMA, SANDBOX_SCHEMA, type SandboxSetting } from '@/lib/serverConfigSchema'

export type ConfigFile = 'ini' | 'sandbox' | 'spawnpoints' | 'spawnregions'
export type SandboxScalar = string | number | boolean | null | undefined
type SandboxRecord = Record<string, SandboxScalar>

/** Sandbox groups the vanilla editor already covers, so Mod options skips them. */
export const VANILLA_SANDBOX_GROUPS = new Set(['Vanilla', 'Map', 'ZombieLore', 'ZombieConfig', 'MultiplierConfig', 'Basement'])

const sectionOf = (setting: SandboxSetting) => (setting.section || 'settings') as keyof SandboxData

export function sandboxValue(data: SandboxData | null | undefined, setting: SandboxSetting): SandboxScalar {
  return (data?.[sectionOf(setting)] as SandboxRecord | undefined)?.[setting.key]
}

export function withSandboxValue(data: SandboxData, section: string, key: string, value: unknown): SandboxData {
  return { ...data, [section]: { ...((data[section as keyof SandboxData] as Record<string, unknown>) || {}), [key]: value } } as SandboxData
}

/** Fills keys the file doesn't have yet with their schema default, so every setting shows. */
export function mergeIniDefaults(parsed: Record<string, string>): Record<string, string> {
  const merged = { ...parsed }
  for (const setting of INI_SCHEMA) {
    if (!(setting.key in merged)) merged[setting.key] = String(setting.default ?? '')
  }
  return merged
}

/** What a new SandboxVars.lua holds when the server has none yet. */
export function sandboxDefaults(): SandboxData {
  const sandbox: SandboxData = { VERSION: 4, settings: {}, ZombieLore: {}, ZombieConfig: {}, MultiplierConfig: {}, Map: {}, Basement: {} }
  for (const setting of SANDBOX_SCHEMA) {
    const values = sandbox[sectionOf(setting)]
    if (typeof values === 'object' && values !== null) values[setting.key] = setting.default ?? ''
  }
  return sandbox
}

export function changedIniFields(current: Record<string, string>, previous: Record<string, string>) {
  return Object.fromEntries(Object.entries(current).filter(([key, value]) => value !== previous[key]))
}

export function changedSandboxFields(current: SandboxData, previous: SandboxData): Partial<SandboxData> {
  const changes: Record<string, Record<string, unknown>> = {}
  for (const [section, values] of Object.entries(current)) {
    if (section === 'VERSION' || !values || typeof values !== 'object') continue
    const before = (previous as unknown as Record<string, Record<string, unknown>>)[section] || {}
    const changed = Object.fromEntries(Object.entries(values as Record<string, unknown>).filter(([key, value]) => value !== before[key]))
    if (Object.keys(changed).length) changes[section] = changed
  }
  return changes as Partial<SandboxData>
}

/** One line of the save preview. Secrets never show. */
export function previewValue(key: string, value: unknown) {
  if (/password|secret|token|api.?key/i.test(key)) return '(hidden)'
  return String(value ?? '(empty)').slice(0, 80)
}

export function rawChangePreview(previous: string, current: string) {
  const before = previous.split(/\r?\n/)
  const after = current.split(/\r?\n/)
  const items: string[] = []
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    if (before[index] === after[index]) continue
    const key = `${before[index]?.split('=')[0] || ''} ${after[index]?.split('=')[0] || ''}`
    items.push(`Line ${index + 1}: ${previewValue(key, before[index])} → ${previewValue(key, after[index])}`)
  }
  return items
}

export function sandboxChangePreview(changes: Partial<SandboxData>, previous: SandboxData | null) {
  return Object.entries(changes).flatMap(([section, values]) =>
    typeof values === 'object' && values
      ? Object.entries(values).map(
          ([key, value]) => `${section}.${key}: ${previewValue(key, (previous?.[section as keyof SandboxData] as SandboxRecord | undefined)?.[key])} → ${previewValue(key, value)}`,
        )
      : [],
  )
}

/** Keys the server couldn't write back, so they reset on the next restart. */
export function getUnpersistedSandboxKeys(data: { unpersistedKeys?: unknown } | null | undefined): string[] | null {
  const keys = data?.unpersistedKeys
  return Array.isArray(keys) && keys.length > 0 ? (keys as string[]) : null
}

/** Classifies a config backup by its file name. */
export function backupFileType(filename: string): ConfigFile | null {
  const name = filename.toLowerCase()
  if (name.includes('_ini_') || name.endsWith('.ini')) return 'ini'
  if (name.includes('sandbox')) return 'sandbox'
  if (name.includes('spawnpoints')) return 'spawnpoints'
  if (name.includes('spawnregions')) return 'spawnregions'
  return null
}
