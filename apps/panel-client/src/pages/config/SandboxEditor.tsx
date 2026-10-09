import { useCallback, useMemo, type RefObject } from 'react'
import { Undo2 } from 'lucide-react'
import type { SandboxData } from '@/lib/api'
import {
  SANDBOX_CATEGORIES,
  SANDBOX_CATEGORY_GROUPS,
  SANDBOX_SCHEMA,
  getSandboxSettingSearchText,
  getUnrecognizedSandboxOptionWarning,
  parseNumericSettingValue,
  type SandboxSetting,
} from '@/lib/serverConfigSchema'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { sandboxValue, withSandboxValue } from './configFiles'
import { SettingRow, type RowField } from './SettingRow'
import { SettingsBrowser, type BrowserItem, type FilterMode } from './SettingsBrowser'
import type { ConfigFiles } from './useConfigFiles'

const idOf = (setting: SandboxSetting) => `${setting.section || 'settings'}.${setting.key}`
const BY_ID = new Map(SANDBOX_SCHEMA.map((setting) => [idOf(setting), setting]))
const FIELDS = new Map<string, RowField>(
  SANDBOX_SCHEMA.map((setting) => [idOf(setting), { ...setting, id: idOf(setting), options: setting.options?.map((option) => ({ value: String(option.value), label: option.label })) }]),
)

export const invalidSandboxSettings = (data: SandboxData | null) =>
  SANDBOX_SCHEMA.filter((setting) => {
    if (setting.type !== 'number') return false
    const value = sandboxValue(data, setting)
    return value !== undefined && value !== null && String(value).trim() !== '' && parseNumericSettingValue(value, setting) === null
  })

const split = (id: string) => {
  const dot = id.indexOf('.')
  return [id.slice(0, dot), id.slice(dot + 1)] as const
}

/** Typed text from the "not in the editor" list goes back as a boolean or number when it looks like one. */
function parseLoose(text: string): string | number | boolean {
  if (text === 'true') return true
  if (text === 'false') return false
  return text !== '' && !Number.isNaN(Number(text)) ? Number(text) : text
}

/** SandboxVars.lua as a form: world, zombies, survival, loot and the rest. */
export function SandboxEditor({
  files,
  search,
  onSearch,
  filter,
  onFilter,
  searchRef,
}: {
  files: ConfigFiles
  search: string
  onSearch: (value: string) => void
  filter: FilterMode
  onFilter: (mode: FilterMode) => void
  searchRef: RefObject<HTMLInputElement | null>
}) {
  const { sandbox, setSandbox } = files
  const data = sandbox.value
  const invalid = useMemo(() => new Set(invalidSandboxSettings(data).map(idOf)), [data])

  const onChange = useCallback(
    (id: string, value: string | boolean) => {
      const setting = BY_ID.get(id)
      const [section, key] = split(id)
      const stored = setting?.type === 'select' && typeof value === 'string' ? Number(value) : value
      setSandbox((prev) => (prev.value ? { ...prev, value: withSandboxValue(prev.value, section, key, stored) } : prev))
    },
    [setSandbox],
  )
  const onReset = useCallback(
    (id: string) => {
      const [section, key] = split(id)
      setSandbox((prev) => {
        const saved = (prev.saved?.[section as keyof SandboxData] as Record<string, unknown> | undefined)?.[key]
        return prev.value && saved !== undefined ? { ...prev, value: withSandboxValue(prev.value, section, key, saved) } : prev
      })
    },
    [setSandbox],
  )

  const differs = (setting: SandboxSetting) => {
    const value = sandboxValue(data, setting)
    return value !== undefined && value !== null && String(value) !== String(setting.default ?? '')
  }
  const unsaved = (setting: SandboxSetting) => JSON.stringify(sandboxValue(data, setting)) !== JSON.stringify(sandboxValue(sandbox.saved, setting))

  const items: BrowserItem[] = SANDBOX_SCHEMA.map((setting) => ({
    id: idOf(setting),
    category: setting.category,
    searchText: getSandboxSettingSearchText(setting),
    unsaved: unsaved(setting),
    differs: differs(setting),
  }))

  const unknown: Array<{ section: string; key: string; value: unknown }> = []
  for (const [section, values] of Object.entries(data ?? {})) {
    if (section === 'VERSION' || !values || typeof values !== 'object') continue
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (key !== 'VERSION' && !BY_ID.has(`${section}.${key}`)) unknown.push({ section, key, value })
    }
  }
  unknown.sort((a, b) => a.section.localeCompare(b.section) || a.key.localeCompare(b.key))

  return (
    <SettingsBrowser
      name="sandbox settings"
      groups={SANDBOX_CATEGORY_GROUPS}
      categories={SANDBOX_CATEGORIES}
      items={items}
      storageKey="serverconfig-sandbox-cat"
      defaultCategory="time"
      search={search}
      onSearch={onSearch}
      filter={filter}
      onFilter={onFilter}
      searchRef={searchRef}
      renderItem={(id) => {
        const setting = BY_ID.get(id)!
        const value = sandboxValue(data, setting)
        const unrecognized =
          setting.type === 'select' && value !== undefined && value !== null && value !== '' && !setting.options?.some((option) => option.value === Number(value))
            ? getUnrecognizedSandboxOptionWarning(String(value))
            : undefined
        return (
          <SettingRow
            key={id}
            field={FIELDS.get(id)!}
            value={setting.type === 'boolean' ? Boolean(value) : String(value ?? '')}
            unsaved={unsaved(setting)}
            differsFromDefault={setting.default !== undefined && JSON.stringify(value) !== JSON.stringify(setting.default)}
            invalid={invalid.has(id)}
            unrecognized={unrecognized}
            onChange={onChange}
            onReset={onReset}
          />
        )
      }}
      extra={{
        label: 'Not in the editor',
        count: unknown.length,
        content: (
          <div>
            <p className="border-b px-3 py-3 text-sm text-muted-foreground">Settings the editor has no description for, by the section that holds them. Mostly added by mods.</p>
            {unknown.map(({ section, key, value }) => {
              const saved = (sandbox.saved?.[section as keyof SandboxData] as Record<string, unknown> | undefined)?.[key]
              return (
                <div key={`${section}.${key}`} className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0">
                  <span className="min-w-0 flex-1 truncate text-sm" title={`${section}.${key}`}>
                    <span className="text-muted-foreground">{section === 'settings' ? '' : `${section}.`}</span>
                    <code className="font-mono">{key}</code>
                  </span>
                  {value !== saved && saved !== undefined && (
                    <Button size="icon-sm" variant="ghost" onClick={() => onReset(`${section}.${key}`)} aria-label={`Undo the change to ${key}`}>
                      <Undo2 />
                    </Button>
                  )}
                  <Input
                    value={String(value)}
                    onChange={(event) => setSandbox((prev) => (prev.value ? { ...prev, value: withSandboxValue(prev.value, section, key, parseLoose(event.target.value)) } : prev))}
                    maxLength={500}
                    className="w-48"
                    aria-label={key}
                  />
                </div>
              )
            })}
          </div>
        ),
      }}
    />
  )
}
