import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, RefreshCw, Search, Undo2, X } from 'lucide-react'
import { gameIntegrationApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { formatModSettingDescription, formatModSettingLabel } from '@/lib/modSettingsLabels'
import { formatRawConfigValue } from '@/lib/serverConfigSchema'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/EmptyState'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { toastManager } from '@/components/ui/toast'
import { Toggle } from '@/components/ui/toggle'
import { VANILLA_SANDBOX_GROUPS } from './configFiles'

interface ModOption {
  name?: string
  shortName?: string
  value?: unknown
  type?: string
  min?: number
  max?: number
  default?: unknown
  enumValues?: string[]
  selectedIndex?: number
  translatedName?: string
  tooltip?: string
  tooltipText?: string
}

interface ModOptionsData {
  options: Record<string, ModOption[]>
  groups: Array<{ name: string; count: number }>
  loadedAt: number
}

const isChanged = (option: ModOption) => {
  if (option.default === undefined || option.default === null) return false
  if (typeof option.default === 'number' && typeof option.value === 'number') return Math.abs(option.default - option.value) >= 0.0001
  return String(option.default) !== String(option.value)
}

const display = (value: unknown) =>
  value === undefined || value === null ? '' : typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : String(value)

/** Sandbox options that installed mods add, read and written live through the game integration. */
export function ModOptions({ active, locked }: { active: boolean; locked: boolean }) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [changedOnly, setChangedOnly] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState<Set<string>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  const queryKey = ['config', 'mod-options']

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<ModOptionsData> => {
      const response = await gameIntegrationApi.getSandboxOptions()
      const data = response.data ?? response
      if (!data.options || !data.groups) throw new Error(response.error || "The game integration didn't send mod options.")
      return {
        options: Object.fromEntries(Object.entries(data.options).filter(([group]) => !VANILLA_SANDBOX_GROUPS.has(group))) as Record<string, ModOption[]>,
        groups: data.groups.filter((group) => !VANILLA_SANDBOX_GROUPS.has(group.name)),
        loadedAt: Date.now(),
      }
    },
    enabled: active,
    retry: false,
    staleTime: Infinity,
  })

  // "/" jumps to the search box, like the old page.
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== '/' || event.ctrlKey || event.metaKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '') || target?.isContentEditable) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  const setOption = async (name: string, value: unknown, group: string) => {
    if (locked) {
      toastManager.add({ title: 'The selected server changed', description: 'Reload the page before changing options.', type: 'error' })
      return
    }
    setSaving((prev) => new Set(prev).add(name))
    try {
      const response = await gameIntegrationApi.setSandboxOption(name, value)
      if (!response.success || !response.data) throw new Error(response.error || "The game didn't confirm the change.")
      const confirmed = response.data.value ?? value
      queryClient.setQueryData<ModOptionsData>(queryKey, (prev) =>
        prev && {
          ...prev,
          options: {
            ...prev.options,
            [group]: prev.options[group].map((option) =>
              option.name !== name ? option : { ...option, value: confirmed, ...(option.type === 'enum' && typeof confirmed === 'number' ? { selectedIndex: confirmed } : {}) },
            ),
          },
        },
      )
      const applied = response.data.applied === true
      const persisted = response.data.persisted === true
      toastManager.add({
        title: applied && persisted ? 'Option changed' : 'Option change needs a look',
        description: `${name}: ${applied ? 'applied live' : "live change wasn't confirmed"}, ${persisted ? 'saved' : 'not saved'}. Restart the server so every saved change takes effect.`,
        type: applied && persisted ? 'success' : 'warning',
      })
    } catch (error) {
      toastManager.add({ title: 'Could not change the option', description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    } finally {
      setSaving((prev) => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
    }
  }

  if (query.isPending && active) return <Skeleton className="h-64" />
  if (!query.data) {
    return query.isError ? (
      <Alert variant="error">
        <AlertTitle>Mod options didn't load</AlertTitle>
        <AlertDescription>{getUserErrorMessage(query.error, 'Check that the server is running with the game integration.')}</AlertDescription>
        <AlertAction>
          <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    ) : (
      <EmptyState type="noMods" title="Mod options" description="These load live from the game while the server runs with the game integration." />
    )
  }

  const { options, groups } = query.data
  if (groups.length === 0) {
    return <EmptyState type="noMods" title="No mod options" description="None of the installed mods add sandbox options, or this game build doesn't report them." />
  }

  const q = search.trim().toLowerCase()
  const filtering = !!q || changedOnly
  const changedCount = Object.values(options).flat().filter(isChanged).length
  const visible = groups
    .map((group) => {
      let list = options[group.name] ?? []
      if (changedOnly) list = list.filter(isChanged)
      if (q && !formatModSettingLabel(group.name).toLowerCase().includes(q)) {
        list = list.filter((option) =>
          [option.name, option.shortName, option.translatedName, formatModSettingLabel(option.translatedName || option.shortName || option.name, group.name), option.tooltip, option.tooltipText].some((text) =>
            text?.toLowerCase().includes(q),
          ),
        )
      }
      return { ...group, list }
    })
    .filter((group) => group.list.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
  const allOpen = visible.length > 0 && visible.every((group) => open.has(group.name))

  return (
    <div className="grid gap-3">
      {query.isError && (
        <Alert variant="warning">
          <AlertDescription>Refreshing failed, so this is the last copy that loaded.</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="max-w-md min-w-48 flex-1">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setSearch('')}
            placeholder="Search mod options (press /)"
            aria-label="Search mod options"
            maxLength={200}
          />
          {search && (
            <InputGroupAddon align="inline-end">
              <Button size="icon-xs" variant="ghost" onClick={() => setSearch('')} aria-label="Clear search">
                <X />
              </Button>
            </InputGroupAddon>
          )}
        </InputGroup>
        <Toggle variant="outline" size="sm" pressed={changedOnly} onPressedChange={setChangedOnly} disabled={changedCount === 0 && !changedOnly}>
          Not default
          {changedCount > 0 && <Badge variant="warning">{changedCount}</Badge>}
        </Toggle>
        <Button size="sm" variant="ghost" onClick={() => setOpen(allOpen ? new Set() : new Set(visible.map((group) => group.name)))} disabled={filtering}>
          {allOpen ? 'Collapse all' : 'Expand all'}
        </Button>
        <span className="ms-auto text-xs text-muted-foreground">
          {groups.length} mods, loaded {new Date(query.data.loadedAt).toLocaleTimeString('en', { timeStyle: 'short' })}
        </span>
        <Button size="icon-sm" variant="ghost" onClick={() => void query.refetch()} disabled={query.isFetching} aria-label="Reload mod options">
          {query.isFetching ? <Spinner /> : <RefreshCw />}
        </Button>
      </div>

      {visible.length === 0 ? (
        <EmptyState compact type="noResults" title="Nothing matches" description={changedOnly ? 'No option differs from its default.' : `No option matches “${search}”.`} />
      ) : (
        <div className="max-h-[calc(100dvh-22rem)] min-h-96 overflow-y-auto rounded-xl border">
          {visible.map((group) => {
            const groupChanged = (options[group.name] ?? []).filter(isChanged).length
            return (
              <Collapsible
                key={group.name}
                open={filtering || open.has(group.name)}
                onOpenChange={(next) =>
                  setOpen((prev) => {
                    const copy = new Set(prev)
                    if (next) copy.add(group.name)
                    else copy.delete(group.name)
                    return copy
                  })
                }
                className="border-b last:border-b-0"
              >
                <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-2.5 text-start text-sm font-medium hover:bg-accent">
                  <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
                  <span className="min-w-0 flex-1 truncate">{formatModSettingLabel(group.name)}</span>
                  {groupChanged > 0 && <Badge variant="warning">{groupChanged} not default</Badge>}
                  <span className="text-xs text-muted-foreground tabular-nums">{group.list.length}</span>
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="divide-y border-t">
                    {group.list.map((option, index) => {
                      const raw = option.shortName || option.name || `Option ${index + 1}`
                      const label = formatModSettingLabel(option.translatedName && option.translatedName !== raw ? option.translatedName : raw, group.name) || `Option ${index + 1}`
                      const tooltip = option.tooltipText || option.tooltip || ''
                      const description = formatModSettingDescription(tooltip.replace(/\n?Default\s*=\s*.*/i, ''))
                      const busy = !!option.name && saving.has(option.name)
                      const type = option.type || 'unknown'
                      const name = option.name
                      const commit = (value: unknown) => name && !busy && void setOption(name, value, group.name)
                      return (
                        <div key={`${name ?? 'option'}-${index}`} className={cn('flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center', busy && 'opacity-60')}>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium" title={name}>
                              {label}
                            </p>
                            {description && (
                              <p className="line-clamp-2 text-sm text-muted-foreground" title={tooltip}>
                                {description}
                              </p>
                            )}
                            {name && name !== label && <p className="truncate font-mono text-xs text-muted-foreground">{name}</p>}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {type === 'boolean' ? (
                              <Switch
                                checked={option.value === true || option.value === 'true' || option.value === 1}
                                onCheckedChange={(checked) => commit(checked)}
                                disabled={busy}
                                aria-label={label}
                              />
                            ) : type === 'enum' && option.enumValues?.length ? (
                              <Select
                                items={option.enumValues.map((text, i) => ({ value: String(i + 1), label: text }))}
                                value={option.selectedIndex !== undefined ? String(option.selectedIndex) : display(option.value)}
                                onValueChange={(next) => {
                                  const picked = Number.parseInt(String(next), 10)
                                  if (!Number.isNaN(picked)) commit(picked)
                                }}
                                disabled={busy}
                              >
                                <SelectTrigger className="w-full sm:w-48" aria-label={label}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectPopup>
                                  {option.enumValues.map((text, i) => (
                                    <SelectItem key={i} value={String(i + 1)}>
                                      {text}
                                    </SelectItem>
                                  ))}
                                </SelectPopup>
                              </Select>
                            ) : (
                              <Input
                                key={`${name}-${display(option.value)}`}
                                type={['number', 'double', 'integer'].includes(type) ? 'number' : 'text'}
                                defaultValue={display(option.value)}
                                min={option.min}
                                max={option.max}
                                step={type === 'integer' ? 1 : 'any'}
                                disabled={busy}
                                aria-label={label}
                                className={cn('w-full', ['number', 'double', 'integer'].includes(type) ? 'text-end sm:w-28' : 'sm:w-44')}
                                onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
                                onBlur={(event) => {
                                  const input = event.currentTarget
                                  if (!['number', 'double', 'integer'].includes(type)) {
                                    if (input.value !== display(option.value)) commit(input.value)
                                    return
                                  }
                                  let number = Number.parseFloat(input.value)
                                  if (Number.isNaN(number)) return
                                  if (option.min !== undefined) number = Math.max(option.min, number)
                                  if (option.max !== undefined) number = Math.min(option.max, number)
                                  if (type === 'integer' && !Number.isInteger(number)) {
                                    toastManager.add({ title: 'Enter a whole number', type: 'error' })
                                    input.value = display(option.value)
                                    return
                                  }
                                  input.value = String(number)
                                  if (number !== option.value) commit(number)
                                }}
                              />
                            )}
                            {option.min !== undefined && option.max !== undefined && (
                              <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                                {option.min} to {option.max}
                              </span>
                            )}
                            {isChanged(option) && option.default !== undefined && (
                              <Button size="xs" variant="ghost" onClick={() => commit(option.default)} disabled={busy} aria-label={`Set ${label} back to its default`}>
                                <Undo2 />
                                {formatRawConfigValue(option.default)}
                              </Button>
                            )}
                            {busy && <Spinner />}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </CollapsiblePanel>
              </Collapsible>
            )
          })}
        </div>
      )}
    </div>
  )
}
