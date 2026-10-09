import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import {
  Archive,
  BarChart,
  Car,
  Clock,
  Cloud,
  Compass,
  Crosshair,
  FileText,
  Filter,
  Gem,
  Globe,
  Heart,
  Home,
  Layers,
  Leaf,
  Map,
  MessageSquare,
  Mic,
  Package,
  Puzzle,
  Radio,
  Search,
  Settings,
  Shield,
  Skull,
  Swords,
  Terminal,
  TrendingUp,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'

const ICONS: Record<string, LucideIcon> = {
  Archive, BarChart, Car, Clock, Cloud, Compass, Crosshair, FileText, Filter, Gem, Globe, Heart, Home, Layers, Leaf, Map,
  MessageSquare, Mic, Package, Puzzle, Radio, Settings, Shield, Skull, Swords, Terminal, TrendingUp, Users, Wrench,
}

export type FilterMode = 'all' | 'changed' | 'unsaved'

const FILTER_KEY = 'serverconfig-filter-mode'

/** The filter is remembered across visits. Older panels stored "modified" for the same filter. */
export function readStoredFilter(): FilterMode {
  try {
    const stored = localStorage.getItem(FILTER_KEY)
    if (stored === 'modified') return 'changed'
    return stored === 'changed' || stored === 'unsaved' ? stored : 'all'
  } catch {
    return 'all'
  }
}

export function storeFilter(mode: FilterMode) {
  try {
    localStorage.setItem(FILTER_KEY, mode)
  } catch {
    /* storage disabled */
  }
}

export interface BrowserItem {
  id: string
  category: string
  searchText: string
  unsaved: boolean
  differs: boolean
}

interface Category {
  id: string
  label: string
  icon: string
  group: string
}

const EXTRA = '__extra'

/** Category list, search and filter around a list of setting rows. Server settings and Sandbox share it. */
export function SettingsBrowser({
  name,
  groups,
  categories,
  items,
  renderItem,
  extra,
  storageKey,
  defaultCategory,
  search,
  onSearch,
  filter,
  onFilter,
  searchRef,
}: {
  name: string
  groups: ReadonlyArray<{ id: string; label: string }>
  categories: Category[]
  items: BrowserItem[]
  renderItem: (id: string) => ReactNode
  extra?: { label: string; count: number; content: ReactNode }
  storageKey: string
  defaultCategory: string
  search: string
  onSearch: (value: string) => void
  filter: FilterMode
  onFilter: (mode: FilterMode) => void
  searchRef?: RefObject<HTMLInputElement | null>
}) {
  const [category, setCategory] = useState(() => {
    try {
      return localStorage.getItem(storageKey) || defaultCategory
    } catch {
      return defaultCategory
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, category)
    } catch {
      /* storage disabled */
    }
  }, [storageKey, category])

  const query = search.trim().toLowerCase()
  const visible = items.filter(
    (item) => (!query || item.searchText.toLowerCase().includes(query)) && (filter === 'all' || (filter === 'changed' ? item.differs : item.unsaved)),
  )
  const byCategory = new globalThis.Map<string, BrowserItem[]>()
  for (const item of visible) byCategory.set(item.category, [...(byCategory.get(item.category) ?? []), item])
  const unsavedIn = (id: string) => items.filter((item) => item.category === id && item.unsaved).length
  const emptyMessage =
    filter === 'changed' ? 'Nothing here differs from the game defaults.' : filter === 'unsaved' ? 'No unsaved changes here.' : 'No settings here.'

  const list = query ? (
    <>
      {categories.map((entry) => {
        const matches = byCategory.get(entry.id) ?? []
        return matches.length === 0 ? null : (
          <section key={entry.id} className="mb-4">
            <h3 className="sticky top-0 z-10 bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground">
              {entry.label} · {matches.length}
            </h3>
            {matches.map((item) => renderItem(item.id))}
          </section>
        )
      })}
      {visible.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No settings match “{search}”.</p>}
    </>
  ) : category === EXTRA && extra ? (
    extra.content
  ) : (
    (() => {
      const rows = byCategory.get(category) ?? []
      return rows.length === 0 ? <p className="p-6 text-center text-sm text-muted-foreground">{emptyMessage}</p> : rows.map((item) => renderItem(item.id))
    })()
  )

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="max-w-md min-w-48 flex-1">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput ref={searchRef} value={search} onChange={(event) => onSearch(event.target.value)} placeholder={`Search ${name}`} aria-label={`Search ${name}`} maxLength={128} />
          {search && (
            <InputGroupAddon align="inline-end">
              <span className="text-xs text-muted-foreground tabular-nums">{visible.length}</span>
              <Button size="icon-xs" variant="ghost" onClick={() => onSearch('')} aria-label="Clear search">
                <X />
              </Button>
            </InputGroupAddon>
          )}
        </InputGroup>
        <Tabs value={filter} onValueChange={(value) => onFilter(value as FilterMode)} className="ms-auto">
          <TabsList aria-label="Filter settings">
            <TabsTab value="all">All</TabsTab>
            <TabsTab value="changed" title="Settings that differ from the game defaults">
              Not default
            </TabsTab>
            <TabsTab value="unsaved">Unsaved</TabsTab>
          </TabsList>
        </Tabs>
      </div>

      <div className="grid overflow-hidden rounded-xl border md:grid-cols-[15rem_minmax(0,1fr)]">
        {!query && (
          <nav aria-label={`${name} categories`} className="flex gap-1 overflow-x-auto border-b p-2 md:max-h-[calc(100dvh-22rem)] md:min-h-96 md:flex-col md:overflow-y-auto md:border-e md:border-b-0">
            {groups.map((group) => (
              <div key={group.id} className="contents md:block">
                <p className="hidden px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground first:pt-1 md:block">{group.label}</p>
                {categories
                  .filter((entry) => entry.group === group.id)
                  .map((entry) => {
                    const Icon = ICONS[entry.icon] ?? Settings
                    const count = (byCategory.get(entry.id) ?? []).length
                    const unsaved = unsavedIn(entry.id)
                    if (count === 0 && filter !== 'all') return null
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => setCategory(entry.id)}
                        aria-current={category === entry.id ? 'page' : undefined}
                        className={cn(
                          'flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm whitespace-nowrap hover:bg-accent md:w-full',
                          category === entry.id ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        <Icon className="size-4 shrink-0 opacity-70" />
                        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                        {unsaved > 0 && <span className="size-1.5 rounded-full bg-warning" aria-label={`${unsaved} unsaved`} />}
                        <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
                      </button>
                    )
                  })}
              </div>
            ))}
            {extra && extra.count > 0 && (
              <button
                type="button"
                onClick={() => setCategory(EXTRA)}
                aria-current={category === EXTRA ? 'page' : undefined}
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm whitespace-nowrap hover:bg-accent md:mt-3 md:w-full md:border-t md:pt-3',
                  category === EXTRA ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{extra.label}</span>
                <span className="text-xs tabular-nums">{extra.count}</span>
              </button>
            )}
          </nav>
        )}
        <div className={cn('max-h-[calc(100dvh-22rem)] min-h-96 overflow-y-auto bg-card', query && 'md:col-span-2')}>{list}</div>
      </div>
    </div>
  )
}
