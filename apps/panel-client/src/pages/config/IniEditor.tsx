import { useCallback, useMemo, type RefObject } from 'react'
import { Undo2 } from 'lucide-react'
import {
  INI_CATEGORIES,
  INI_CATEGORY_GROUPS,
  INI_SCHEMA,
  getIniSettingSearchText,
  parseNumericSettingValue,
} from '@/lib/serverConfigSchema'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingRow } from './SettingRow'
import { SettingsBrowser, type BrowserItem, type FilterMode } from './SettingsBrowser'
import type { ConfigFiles } from './useConfigFiles'

const SCHEMA_KEYS = new Set(INI_SCHEMA.map((setting) => setting.key))
const BY_KEY = new Map(INI_SCHEMA.map((setting) => [setting.key, setting]))

export const invalidIniKeys = (values: Record<string, string>) =>
  INI_SCHEMA.filter((setting) => setting.type === 'number' && String(values[setting.key] ?? '').trim() !== '' && parseNumericSettingValue(values[setting.key], setting) === null)

/** The server's .ini as a form: networking, players, safety, mods and the rest. */
export function IniEditor({
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
  const { ini, setIni } = files
  const values = ini.value
  const invalid = useMemo(() => new Set(invalidIniKeys(values).map((setting) => setting.key)), [values])

  const onChange = useCallback(
    (key: string, value: string | boolean) => setIni((prev) => ({ ...prev, value: { ...prev.value, [key]: typeof value === 'boolean' ? String(value) : value } })),
    [setIni],
  )
  const onReset = useCallback((key: string) => setIni((prev) => ({ ...prev, value: { ...prev.value, [key]: prev.saved[key] ?? '' } })), [setIni])

  const items: BrowserItem[] = INI_SCHEMA.map((setting) => ({
    id: setting.key,
    category: setting.category,
    searchText: getIniSettingSearchText(setting),
    unsaved: ini.saved[setting.key] !== undefined && values[setting.key] !== ini.saved[setting.key],
    differs: setting.defaultComparable !== false && values[setting.key] !== undefined && String(values[setting.key]) !== String(setting.default ?? ''),
  }))

  const unknownKeys = Object.keys(values)
    .filter((key) => !SCHEMA_KEYS.has(key))
    .sort()

  return (
    <div className="grid gap-3">
      {values.DoLuaChecksum?.toLowerCase() === 'true' && (
        <Alert variant="error">
          <AlertTitle>Lua checksum is on, so players can't join</AlertTitle>
          <AlertDescription>The game integration changes server Lua files, which fails the checksum players' games run. Turn DoLuaChecksum off, then save.</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => onChange('DoLuaChecksum', 'false')}>
              Turn it off
            </Button>
          </AlertAction>
        </Alert>
      )}
      <SettingsBrowser
        name="server settings"
        groups={INI_CATEGORY_GROUPS}
        categories={INI_CATEGORIES}
        items={items}
        storageKey="serverconfig-ini-cat"
        defaultCategory="general"
        search={search}
        onSearch={onSearch}
        filter={filter}
        onFilter={onFilter}
        searchRef={searchRef}
        renderItem={(key) => {
          const setting = BY_KEY.get(key)!
          const value = values[key] ?? ''
          return (
            <SettingRow
              key={key}
              field={setting}
              value={setting.type === 'boolean' ? value.toLowerCase() === 'true' : value}
              unsaved={ini.saved[key] !== undefined && value !== ini.saved[key]}
              differsFromDefault={setting.default !== undefined && value !== String(setting.default)}
              invalid={invalid.has(key)}
              onChange={onChange}
              onReset={onReset}
            />
          )
        }}
        extra={{
          label: 'Not in the editor',
          count: unknownKeys.length,
          content: (
            <div>
              <p className="border-b px-3 py-3 text-sm text-muted-foreground">
                These keys are in the file but the editor doesn't know them. They're usually newer game settings or added by mods. They're kept as they are when you save.
              </p>
              {unknownKeys.map((key) => {
                const unsaved = ini.saved[key] !== undefined && values[key] !== ini.saved[key]
                return (
                  <div key={key} className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0">
                    <code className="min-w-0 flex-1 truncate font-mono text-sm" title={key}>
                      {key}
                    </code>
                    {unsaved && (
                      <Button size="icon-sm" variant="ghost" onClick={() => onReset(key)} aria-label={`Undo the change to ${key}`}>
                        <Undo2 />
                      </Button>
                    )}
                    <Input value={values[key]} onChange={(event) => onChange(key, event.target.value)} maxLength={500} className="w-56" aria-label={key} />
                  </div>
                )
              })}
            </div>
          ),
        }}
      />
    </div>
  )
}
