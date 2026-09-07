import { useEffect, useState, useCallback, useMemo } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import {
  Search,
  RefreshCw,
  Users,
  MapPin,
  Lock,
  Shield,
  Server,
  Globe,
  Loader2,
  AlertCircle,
  Filter,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Copy,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { EmptyState } from '@/components/EmptyState'
import { HelpTip } from '@/components/HelpTip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Link } from '@tanstack/react-router'
import { useToast } from '@/components/ui/use-toast'
import { apiFetch, ApiError } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { copyText } from '@/lib/utils'

interface GameServer {
  name: string
  ip: string
  port: number | null
  gamePort?: number | null
  players: number
  maxPlayers: number
  map: string
  version: string
  vac: boolean
  isPrivate: boolean
  os: string
  dedicated?: boolean
  bots?: number
  keywords?: string
  tags?: string[]
  ping?: number | null
}

type SortField = 'name' | 'players' | 'maxPlayers' | 'ping'
type SortDirection = 'asc' | 'desc'

export function pingKey(server: Pick<GameServer, 'ip' | 'port'>): string | null {
  return server.port === null || server.port === undefined ? null : `${server.ip}:${server.port}`
}

export function displayPort(server: Pick<GameServer, 'port' | 'gamePort'>): number | null {
  return server.gamePort || server.port || null
}

export function displayAddress(server: Pick<GameServer, 'ip' | 'port' | 'gamePort'>): string {
  const port = displayPort(server)
  return port === null ? server.ip : `${server.ip}:${port}`
}

export function emptyServersDescKey(apiKeyConfigured: boolean, emptyReason?: string): string {
  if (!apiKeyConfigured) return 'emptyState.noApiKeyDesc'
  if (emptyReason === 'master-unreachable') return 'emptyState.noServersDescUnreachable'
  if (emptyReason === 'no-servers-responded') return 'emptyState.noServersDescNoneResponded'
  if (emptyReason === 'no-servers-listed') return 'emptyState.noServersDescGenuinelyEmpty'
  return 'emptyState.noServersDesc'
}

export function pingFailDescKey(reason?: string): string {
  return reason === 'unparseable-response' ? 'serverItem.pingFailUnparseable' : 'serverItem.pingFailUnreachable'
}

export default function ServerFinder() {
  const { t, i18n } = useTranslation('serverFinder')
  const [servers, setServers] = useState<GameServer[]>([])
  const [filteredServers, setFilteredServers] = useState<GameServer[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<string>('')
  const [cached, setCached] = useState(false)
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean>(true)
  const [emptyReason, setEmptyReason] = useState<string | undefined>(undefined)
  const [stats, setStats] = useState({ totalPlayers: 0, activeServers: 0, totalCapacity: 0 })
  const [currentPage, setCurrentPage] = useState(1)
  const { toast } = useToast()

  const [searchQuery, setSearchQuery] = useState('')
  const debouncedSearch = useDebouncedValue(searchQuery, 200)
  const [hideEmpty, setHideEmpty] = useState(false)
  const [hideFull, setHideFull] = useState(false)
  const [hidePrivate, setHidePrivate] = useState(false)
  const [showVacOnly, setShowVacOnly] = useState(false)
  const [versionFilter, setVersionFilter] = useState<string>('all')
  const [filtersOpen, setFiltersOpen] = useState(false)

  const [sortField, setSortField] = useState<SortField>('players')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  const [pingingServers, setPingingServers] = useState<Set<string>>(new Set())
  const [serverPings, setServerPings] = useState<Record<string, number | null>>({})
  const [pingFailReasons, setPingFailReasons] = useState<Record<string, string>>({})

  const ITEMS_PER_PAGE = 50

  const fetchServers = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError(null)
    setCurrentPage(1)

    try {
      const url = forceRefresh ? '/api/server-finder?refresh=true' : '/api/server-finder'
      const response = await apiFetch(url.replace('/api', ''))
      const data = await response.json().catch(() => null)

      if (!response.ok || !data || data.success === false) {
        throw new ApiError(data?.error || `HTTP ${response.status}`, {
          status: response.status,
          code: data?.code,
        })
      }

      setServers(data.servers || [])
      setSource(data.source || 'unknown')
      setCached(data.cached || false)
      setApiKeyConfigured(data.apiKeyConfigured !== false)
      setEmptyReason(data.emptyReason)
      setStats({
        totalPlayers: data.totalPlayers || 0,
        activeServers: data.activeServers || 0,
        totalCapacity: data.totalCapacity || 0,
      })

      if (data.apiKeyConfigured === false) {
        setError(t('toasts.apiKeyMissing'))
      }

      if (data.servers?.length > 0) {
        toast({
          title: data.cached ? t('toasts.loadedCachedTitle') : t('toasts.loadedTitle'),
          description: t('toasts.loadedDesc', { count: data.count, players: data.totalPlayers || 0 }),
        })
      }
    } catch (err) {
      setError(getUserErrorMessage(err, t('toasts.fetchFailedFallback')))
    } finally {
      setLoading(false)
    }
  }, [toast, t])

  useEffect(() => {
    fetchServers()
  }, [fetchServers])

  useEffect(() => {
    let result = [...servers]

    if (debouncedSearch) {
      const query = debouncedSearch.toLowerCase()
      result = result.filter(
        s =>
          s.name.toLowerCase().includes(query) ||
          s.ip.includes(query) ||
          s.map?.toLowerCase().includes(query) ||
          s.keywords?.toLowerCase().includes(query)
      )
    }

    if (hideEmpty) {
      result = result.filter(s => s.players > 0)
    }
    if (hideFull) {
      result = result.filter(s => s.players < s.maxPlayers)
    }
    if (hidePrivate) {
      result = result.filter(s => !s.isPrivate)
    }
    if (showVacOnly) {
      result = result.filter(s => s.vac)
    }
    if (versionFilter && versionFilter !== 'all') {
      result = result.filter(s => s.version === versionFilter)
    }

    result.sort((a, b) => {
      let aVal: number | string
      let bVal: number | string

      switch (sortField) {
        case 'name':
          aVal = a.name.toLowerCase()
          bVal = b.name.toLowerCase()
          break
        case 'players':
          aVal = a.players
          bVal = b.players
          break
        case 'maxPlayers':
          aVal = a.maxPlayers
          bVal = b.maxPlayers
          break
        case 'ping': {
          const aKey = pingKey(a)
          const bKey = pingKey(b)
          aVal = (aKey ? serverPings[aKey] : undefined) ?? 9999
          bVal = (bKey ? serverPings[bKey] : undefined) ?? 9999
          break
        }
        default:
          return 0
      }

      if (typeof aVal === 'string') {
        return sortDirection === 'asc'
          ? aVal.localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal)
      }

      return sortDirection === 'asc' ? aVal - (bVal as number) : (bVal as number) - aVal
    })

    setFilteredServers(result)
    // Only reset to page 1 when actual filters/sort change, not when pings update
  }, [servers, debouncedSearch, hideEmpty, hideFull, hidePrivate, showVacOnly, versionFilter, sortField, sortDirection]) // eslint-disable-line react-hooks/exhaustive-deps -- serverPings intentionally excluded to avoid pagination reset on ping updates

  useEffect(() => {
    setCurrentPage(1)
  }, [debouncedSearch, hideEmpty, hideFull, hidePrivate, showVacOnly, versionFilter, sortField, sortDirection])

  useEffect(() => {
    if (sortField !== 'ping') return
    setFilteredServers(prev => {
      const sorted = [...prev]
      sorted.sort((a, b) => {
        const aKey = pingKey(a)
        const bKey = pingKey(b)
        const aVal = (aKey ? serverPings[aKey] : undefined) ?? 9999
        const bVal = (bKey ? serverPings[bKey] : undefined) ?? 9999
        return sortDirection === 'asc' ? aVal - bVal : bVal - aVal
      })
      return sorted
    })
  }, [serverPings, sortField, sortDirection])

  const availableVersions = useMemo(() => {
    const versions = new Set<string>()
    servers.forEach(s => {
      if (s.version) versions.add(s.version)
    })
    return Array.from(versions).sort((a, b) => {
      const aParts = a.split('.').map(Number)
      const bParts = b.split('.').map(Number)
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aVal = aParts[i] || 0
        const bVal = bParts[i] || 0
        if (aVal !== bVal) return bVal - aVal
      }
      return 0
    })
  }, [servers])

  const totalPages = Math.max(1, Math.ceil(filteredServers.length / ITEMS_PER_PAGE))

  useEffect(() => {
    setCurrentPage(prev => Math.min(prev, totalPages))
  }, [totalPages])

  const paginatedServers = useMemo(() => filteredServers.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  ), [filteredServers, currentPage])

  const goToPage = (page: number) => {
    const validPage = Math.max(1, Math.min(page, totalPages))
    setCurrentPage(validPage)
  }

  const copyAddress = async (address: string) => {
    const ok = await copyText(address)
    if (ok) {
      toast({ title: t('serverItem.addressCopiedTitle'), description: address })
    } else {
      toast({
        title: t('serverItem.addressCopyFailedTitle'),
        variant: 'destructive',
      })
    }
  }

  const pingServer = async (ip: string, port: number | null) => {
    if (port === null) return
    const key = `${ip}:${port}`
    if (pingingServers.has(key)) return

    setPingingServers(prev => new Set([...prev, key]))

    try {
      const response = await apiFetch(`/server-finder/ping?ip=${ip}&port=${port}`)
      const data = await response.json()

      if (data.success && data.ping !== null) {
        setServerPings(prev => ({ ...prev, [key]: data.ping }))
        setPingFailReasons(prev => { const { [key]: _drop, ...rest } = prev; return rest })
      } else {
        setServerPings(prev => ({ ...prev, [key]: null }))
        setPingFailReasons(prev => ({ ...prev, [key]: data.reason || 'timeout' }))
      }
    } catch {
      setServerPings(prev => ({ ...prev, [key]: null }))
      setPingFailReasons(prev => ({ ...prev, [key]: 'request-failed' }))
    } finally {
      setPingingServers(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDirection(field === 'name' ? 'asc' : 'desc')
    }
  }

  const SortButton = ({ field, label }: { field: SortField; label: string }) => (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => toggleSort(field)}
      className="h-8 px-2 flex items-center gap-1"
      aria-label={sortField === field
        ? t('serverList.sortAriaWithDirection', { label, direction: sortDirection === 'asc' ? t('serverList.directionAscending') : t('serverList.directionDescending') })
        : t('serverList.sortAria', { label })}
    >
      {label}
      {sortField === field ? (
        sortDirection === 'asc' ? (
          <ChevronUp className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        )
      ) : (
        <ArrowUpDown className="h-4 w-4 opacity-50" />
      )}
    </Button>
  )

  const getPingColor = (ping: number | null | undefined) => {
    if (ping === null || ping === undefined) return 'text-muted-foreground'
    if (ping < 50) return 'text-primary'
    if (ping < 100) return 'text-warning'
    if (ping < 200) return 'text-warning'
    return 'text-destructive'
  }

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        icon={<Globe className="w-5 h-5" />}
        actions={
          <>
            <Button variant="outline" onClick={() => fetchServers(false)} disabled={loading}>
              {loading ? (
                <Loader2 className="h-4 w-4 me-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 me-2" />
              )}
              {t('pageHeader.refreshList')}
            </Button>
            <Button onClick={() => fetchServers(true)} disabled={loading}>
              <RefreshCw className="h-4 w-4 me-2" />
              {t('pageHeader.reloadFromSteam')}
            </Button>
            <HelpTip label={t('pageHeader.reloadFromSteam')}>{t('pageHeader.reloadFromSteamTip')}</HelpTip>
          </>
        }
      />

      {!apiKeyConfigured && !loading && (
        <Card className="border-warning/40 bg-warning/10 shadow-sm">
          <CardContent className="flex items-start gap-4 py-4">
            <AlertCircle className="h-6 w-6 text-warning shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-warning">{t('apiKeyWarning.title')}</p>
              <p className="text-sm text-muted-foreground">
                {t('apiKeyWarning.description')}
              </p>
              <ol className="text-sm text-muted-foreground list-decimal list-inside space-y-1 mt-2">
                <li>
                  <Trans
                    i18nKey="apiKeyWarning.step1"
                    t={t}
                    components={{
                      1: <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" />,
                      2: <span className="sr-only" />,
                    }}
                  />
                </li>
                <li>
                  <Trans
                    i18nKey="apiKeyWarning.step2"
                    t={t}
                    components={{ 1: <Link to="/settings" className="text-primary hover:underline" /> }}
                  />
                </li>
                <li>{t('apiKeyWarning.step3')}</li>
              </ol>
            </div>
          </CardContent>
        </Card>
      )}

      {(() => {
        const isFiltered = filteredServers.length !== servers.length
        const tiles = [
          {
            icon: Server,
            label: t('stats.totalServers'),
            value: servers.length.toLocaleString(i18n.language),
            sub: `${source === 'steam_api' ? t('stats.viaSteamApi') : t('stats.viaMasterServer')}${cached ? t('stats.cachedSuffix') : ''}`,
            tone: 'muted' as const,
          },
          {
            icon: Globe,
            label: t('stats.activeServers'),
            value: stats.activeServers.toLocaleString(i18n.language),
            sub: t('stats.withPlayersOnline'),
            tone: 'primary' as const,
          },
          {
            icon: Users,
            label: t('stats.totalPlayers'),
            value: stats.totalPlayers.toLocaleString(i18n.language),
            sub: t('stats.playingNow'),
            tone: 'primary' as const,
          },
          {
            icon: Filter,
            label: t('stats.showing'),
            value: filteredServers.length.toLocaleString(i18n.language),
            sub: isFiltered ? t('stats.filteredOf', { count: servers.length.toLocaleString(i18n.language) }) : t('stats.matchingFilters'),
            tone: isFiltered ? ('warning' as const) : ('muted' as const),
          },
        ]
        const toneClass = (tone: 'primary' | 'warning' | 'muted') =>
          tone === 'primary'
            ? 'border-primary/30 bg-primary/[0.06] text-primary'
            : tone === 'warning'
            ? 'border-warning/40 bg-warning/10 text-warning'
            : 'border-border/55 bg-muted/30 text-muted-foreground'
        return (
          <div className="grid gap-3 md:grid-cols-4 stagger-in">
            {tiles.map(({ icon: Icon, label, value, sub, tone }) => (
              <Card key={label}>
                <CardContent className="flex items-center gap-3 p-4">
                  <div className={`grid place-items-center w-10 h-10 rounded-md border shrink-0 ${toneClass(tone)}`} aria-hidden="true">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
                    <p className="text-xl font-semibold leading-tight tabular-nums">{value}</p>
                    {sub && <p className="text-[11px] text-muted-foreground/80 truncate">{sub}</p>}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )
      })()}

      <Card className="border-border/70 bg-card/92 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">{t('searchFilters.title')}</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setFiltersOpen(!filtersOpen)}>
              <Filter className="h-4 w-4 me-2" />
              {filtersOpen ? t('searchFilters.hideFilters') : t('searchFilters.showFilters')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('searchFilters.searchPlaceholder')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="ps-9"
              aria-label={t('searchFilters.searchAria')}
              maxLength={128}
            />
          </div>

          {filtersOpen && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="hideEmpty"
                    checked={hideEmpty}
                    onCheckedChange={(checked) => setHideEmpty(checked === true)}
                  />
                  <Label htmlFor="hideEmpty" className="text-sm cursor-pointer">
                    {t('searchFilters.hideEmpty')}
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="hideFull"
                    checked={hideFull}
                    onCheckedChange={(checked) => setHideFull(checked === true)}
                  />
                  <Label htmlFor="hideFull" className="text-sm cursor-pointer">
                    {t('searchFilters.hideFull')}
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="hidePrivate"
                    checked={hidePrivate}
                    onCheckedChange={(checked) => setHidePrivate(checked === true)}
                  />
                  <Label htmlFor="hidePrivate" className="text-sm cursor-pointer">
                    {t('searchFilters.hidePrivate')}
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="showVacOnly"
                    checked={showVacOnly}
                    onCheckedChange={(checked) => setShowVacOnly(checked === true)}
                  />
                  <Label htmlFor="showVacOnly" className="text-sm cursor-pointer">
                    {t('searchFilters.vacOnly')}
                  </Label>
                </div>
              </div>

              <Separator className="my-4" />

              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Label className="text-sm">{t('searchFilters.versionLabel')}</Label>
                  <Select value={versionFilter} onValueChange={setVersionFilter}>
                    <SelectTrigger className="w-32">
                      <SelectValue placeholder={t('searchFilters.allVersions')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('searchFilters.allVersions')}</SelectItem>
                      {availableVersions.map(v => (
                        <SelectItem key={v} value={v}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Separator orientation="vertical" className="h-6 hidden md:block" />

                <div className="flex items-center gap-2">
                  <Label className="text-sm">{t('searchFilters.sortByLabel')}</Label>
                  <Select value={sortField} onValueChange={(v) => setSortField(v as SortField)}>
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="players">{t('searchFilters.sortPlayers')}</SelectItem>
                      <SelectItem value="name">{t('searchFilters.sortName')}</SelectItem>
                      <SelectItem value="maxPlayers">{t('searchFilters.sortMaxPlayers')}</SelectItem>
                      <SelectItem value="ping">{t('searchFilters.sortPing')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={sortDirection} onValueChange={(v) => setSortDirection(v as SortDirection)}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="asc">{t('searchFilters.ascending')}</SelectItem>
                      <SelectItem value="desc">{t('searchFilters.descending')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/40 bg-destructive/10 shadow-sm">
          <CardContent className="flex items-center gap-4 py-4">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <div>
              <p className="font-medium text-destructive">{t('error.title')}</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
            <Button variant="outline" onClick={() => fetchServers()} className="ms-auto">
              {t('error.retry')}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card className="border-border/70 bg-card/92 shadow-sm">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{t('serverList.title')}</CardTitle>
            <div className="flex items-center gap-2">
              <SortButton field="name" label={t('searchFilters.sortName')} />
              <SortButton field="players" label={t('searchFilters.sortPlayers')} />
              <SortButton field="ping" label={t('searchFilters.sortPing')} />
            </div>
          </div>
          <CardDescription>
            {t('serverList.description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="ms-3 text-muted-foreground">{t('serverList.loading')}</span>
            </div>
          ) : filteredServers.length === 0 ? (
            <div className="text-center py-12">
              {servers.length === 0 ? (
                <EmptyState
                  type="noResults"
                  title={apiKeyConfigured ? t('emptyState.noServersTitle') : t('emptyState.noApiKeyTitle')}
                  description={t(emptyServersDescKey(apiKeyConfigured, emptyReason))}
                />
              ) : (
                <EmptyState
                  type="noResults"
                  title={t('emptyState.noMatchTitle')}
                  description={t('emptyState.noMatchDesc')}
                  action={{
                    label: t('emptyState.clearFilters'),
                    onClick: () => {
                      setSearchQuery('')
                      setHideEmpty(false)
                      setHideFull(false)
                      setHidePrivate(false)
                      setShowVacOnly(false)
                    }
                  }}
                />
              )}
            </div>
          ) : (
            <ScrollArea className="h-[400px] sm:h-[600px]">
              <div className="space-y-2">
                {paginatedServers.map((server, index) => {
                  const serverKey = `${server.ip}:${server.port}`
                  const pKey = pingKey(server)
                  const ping = pKey ? serverPings[pKey] : undefined
                  const isPinging = pKey ? pingingServers.has(pKey) : false
                  const address = displayAddress(server)
                  const isFull = server.players >= server.maxPlayers && server.maxPlayers > 0
                  const hasPlayers = server.players > 0 && !isFull
                  const statusTone = isFull
                    ? 'border-destructive/40 bg-destructive/[0.08] text-destructive'
                    : hasPlayers
                    ? 'border-primary/30 bg-primary/[0.07] text-primary'
                    : 'border-border/50 bg-muted/40 text-muted-foreground'

                  return (
                    <div
                      key={`${serverKey}-${index}`}
                      className="flex items-center gap-3 p-3 rounded-lg border border-border/60 bg-card/70 hover:border-primary/30 hover:bg-accent/20 transition-colors"
                    >
                      <div className={`grid place-items-center w-9 h-9 rounded-md border shrink-0 ${statusTone}`} aria-hidden="true">
                        <Server className="h-4 w-4" />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-medium truncate">{server.name}</h3>
                          {server.isPrivate && (
                            <Tooltip>
                              <TooltipTrigger>
                                <Lock className="h-4 w-4 text-warning" />
                              </TooltipTrigger>
                              <TooltipContent>{t('serverItem.passwordProtected')}</TooltipContent>
                            </Tooltip>
                          )}
                          {server.vac && (
                            <Tooltip>
                              <TooltipTrigger>
                                <Shield className="h-4 w-4 text-primary" />
                              </TooltipTrigger>
                              <TooltipContent>{t('serverItem.vacSecured')}</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  copyAddress(address)
                                }}
                                className="flex items-center gap-1 rounded hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                                aria-label={t('serverItem.copyAddressAria', { address })}
                              >
                                <Globe className="h-3 w-3" />
                                {address}
                                <Copy className="h-3 w-3 opacity-50" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>{t('serverItem.copyAddress')}</TooltipContent>
                          </Tooltip>
                          {server.map && (
                            <span className="flex items-center gap-1">
                              <MapPin className="h-3 w-3 shrink-0" />
                              <span className="truncate">{server.map}</span>
                            </span>
                          )}
                          {server.version && (
                            <Badge variant="outline" className="text-xs">
                              v{server.version}
                            </Badge>
                          )}
                        </div>
                        {server.tags && server.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {server.tags.slice(0, 5).map((tag, i) => (
                              <Badge key={i} variant="secondary" className="text-xs px-1.5 py-0 max-w-[150px] truncate">
                                {tag}
                              </Badge>
                            ))}
                            {server.tags.length > 5 && (
                              <Badge variant="secondary" className="text-xs px-1.5 py-0">
                                +{server.tags.length - 5}
                              </Badge>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 px-3">
                        <Users className="h-4 w-4 text-muted-foreground" />
                        <span
                          className={
                            server.players >= server.maxPlayers
                                ? 'text-destructive font-medium'
                              : server.players > 0
                                ? 'text-primary font-medium'
                              : 'text-muted-foreground'
                          }
                        >
                          {server.players}/{server.maxPlayers}
                        </span>
                      </div>

                      <div className="w-16 text-center">
                        {isPinging ? (
                          <Loader2 className="h-4 w-4 animate-spin mx-auto text-muted-foreground" />
                        ) : ping !== undefined ? (
                          ping !== null ? (
                            <span className={`text-sm font-medium ${getPingColor(ping)}`}>
                              {t('serverItem.pingMs', { ping })}
                            </span>
                          ) : (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="text-sm font-medium text-muted-foreground cursor-help">
                                  {t('serverItem.pingNa')}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-56 text-start">
                                {t(pingFailDescKey(pKey ? pingFailReasons[pKey] : undefined))}
                              </TooltipContent>
                            </Tooltip>
                          )
                        ) : pKey === null ? (
                          <span className="text-sm text-muted-foreground">{t('serverItem.pingNa')}</span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              pingServer(server.ip, server.port)
                            }}
                            className="h-9 px-3 text-xs"
                          >
                            {t('serverItem.pingButton')}
                          </Button>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="default"
                              size="sm"
                              className="h-7 px-2"
                              disabled={displayPort(server) === null}
                              onClick={() => {
                                window.open(`steam://connect/${address}`, '_self')
                              }}
                            >
                              {t('serverItem.connect')}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{t('serverItem.connectTooltip')}</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>

        {filteredServers.length > ITEMS_PER_PAGE && (
          <div className="flex items-center justify-between p-4 border-t bg-card">
            <div className="text-sm text-muted-foreground">
              {t('pagination.showing', {
                from: ((currentPage - 1) * ITEMS_PER_PAGE) + 1,
                to: Math.min(currentPage * ITEMS_PER_PAGE, filteredServers.length),
                total: filteredServers.length.toLocaleString(i18n.language),
              })}
            </div>
            <nav aria-label={t('pagination.nav')} className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(1)}
                disabled={currentPage <= 1}
                aria-label={t('pagination.firstAria')}
              >
                <ChevronsLeft className="h-4 w-4" />
                {t('pagination.first')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1}
                aria-label={t('pagination.prevAria')}
              >
                <ChevronLeft className="h-4 w-4" />
                {t('pagination.prev')}
              </Button>
              <div className="flex items-center gap-2 px-2" aria-current="page">
                <span className="text-sm font-medium">{t('pagination.pageOf', { current: currentPage, total: totalPages })}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= totalPages}
                aria-label={t('pagination.nextAria')}
              >
                {t('pagination.next')}
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(totalPages)}
                disabled={currentPage >= totalPages}
                aria-label={t('pagination.lastAria')}
              >
                {t('pagination.last')}
                <ChevronsRight className="h-4 w-4" />
              </Button>
            </nav>
          </div>
        )}
      </Card>
    </div>
  )
}
