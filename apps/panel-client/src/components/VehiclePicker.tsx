import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Search, RefreshCw, Loader2, X, ChevronDown, AlertCircle, SearchX, Car, Users, Truck, Bus, Shield, Zap, Mountain, Package, type LucideIcon } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { panelBridgeApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useToast } from '@/components/ui/use-toast'

export interface CatalogVehicle {
  id: string
  name: string
  // Both optional, not a stray gap: PanelBridge.lua only sets these on a
  // successful pcall -- getSeatNumber() is a known B42 Kahlua thrower, so
  // getMass()/the seat-count getters can genuinely come back unset (server/
  // backlog card
  // api-ts-declares-catalog-weight-mass-seats-non-optional-but-lua-guards-them,
  // 2026-08-29). A missing value is a real, expected runtime shape, not a
  // bug to paper over with a fallback of 0.
  mass?: number
  seats?: number
}

interface VehiclePickerProps {
  value: string
  onChange: (vehicleId: string) => void
  disabled?: boolean
  placeholder?: string
}

// Classify vehicles into types by name/id patterns, mass, and seat count
export function getVehicleType(v: CatalogVehicle): string {
  const raw = `${v.name || ''} ${v.id}`.toLowerCase()
  const id = v.id.toLowerCase().replace(/^base\./, '')

  // Trailers: typically 0 seats, or explicit trailer/cart names
  if (/trailer|\bcart\b/.test(raw)) return 'Trailers'
  if (v.seats === 0 && typeof v.mass === 'number' && v.mass > 0) return 'Trailers'

  // Emergency & Military — check BEFORE generic types to catch police/military variants
  // PZ B42 military CUCV series: M1008, M1009, M1010, M1028 etc.
  if (/police|\bcop\b|sheriff|firetruck|fire.?engine|military|army|m10[0-9]{2}|humvee|hmm?wv|cucv|armou?red|swat|ambulance|\bems\b/.test(raw))
    return 'Emergency & Military'
  // Police/military suffixes on vehicle IDs: pd (police dept), ksp (KY state police), mp (military police)
  if (/(?:pd|ksp|mp|trooper|patrol)$/i.test(id)) return 'Emergency & Military'
  if (/lightsbar|lightbar|siren/.test(raw)) return 'Emergency & Military'

  // Vans & Buses
  if (/\bvan\b|\bbus\b|minivan|stepvan|minibus|schoolbus/.test(raw)) return 'Vans & Buses'

  // Trucks & Pickups
  if (/truck|pickup|pick.?up|\bsemi\b|\btow\b|flatnose|\bdump\b|plow|hauler|flat.?bed/.test(raw)) return 'Trucks'

  // Performance / Sports
  if (/sport|muscle|\brace\b|\bfast\b|corvette|camaro|mustang|\bgto\b|charger|firebird|trans.?am/.test(raw)) return 'Performance'

  // SUVs & Off-road (blazer, K5 are Chevy SUVs)
  if (/\bsuv\b|offroad|off.?road|4x4|\bjeep\b|blazer|\bk5|wrangler|bronco|scout/.test(raw)) return 'SUVs & Off-road'

  // Mass/seats-based fallback for uncategorized vehicles
  if (typeof v.mass === 'number' && v.mass > 5000) return 'Trucks'
  if (typeof v.seats === 'number' && v.seats >= 7) return 'Vans & Buses'

  return 'Sedans'
}

/** Strip Base. prefix and return a cleaner display name */
export function formatVehicleName(v: CatalogVehicle): string {
  // If the game provided a real display name, use it
  if (v.name && v.name !== v.id && !v.name.startsWith('Base.')) return v.name
  return (v.name || v.id).replace(/^Base\./, '')
}

export const TYPE_ORDER: Record<string, number> = {
  'Sedans': 0, 'Performance': 1, 'SUVs & Off-road': 2,
  'Trucks': 3, 'Vans & Buses': 4, 'Emergency & Military': 5, 'Trailers': 6,
}

export const TYPE_ICON: Record<string, LucideIcon> = {
  'Sedans': Car, 'Performance': Zap, 'SUVs & Off-road': Mountain,
  'Trucks': Truck, 'Vans & Buses': Bus, 'Emergency & Military': Shield, 'Trailers': Package,
}

const MAX_VISIBLE = 100

export function VehiclePicker({ value, onChange, disabled, placeholder }: VehiclePickerProps) {
  const { t, i18n } = useTranslation('vehiclePicker')
  const resolvedPlaceholder = placeholder ?? t('searchVehiclesPlaceholder')
  const [vehicles, setVehicles] = useState<CatalogVehicle[]>([])
  const [initialLoad, setInitialLoad] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const [scannedAt, setScannedAt] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // Not a Radix primitive, so closing the dropdown doesn't automatically
  // restore focus to the trigger the way a Radix Popover/Select would.
  const triggerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [dropUp, setDropUp] = useState(false)
  const { toast } = useToast()

  // Load cached catalog
  useEffect(() => {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const data = await panelBridgeApi.getCatalogVehicles()
        if (ctrl.signal.aborted) return
        setVehicles(data.vehicles || [])
        setScannedAt(data.scannedAt)
      } catch {
        // No catalog yet
      } finally {
        if (!ctrl.signal.aborted) setInitialLoad(false)
      }
    })()
    return () => ctrl.abort()
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => { setHighlightIndex(-1) }, [search])

  useEffect(() => {
    if (!open || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setDropUp(window.innerHeight - rect.bottom < 340)
  }, [open])

  const handleScan = useCallback(async () => {
    if (scanning) return
    setScanning(true)
    setScanError(null)
    try {
      const data = await panelBridgeApi.scanCatalogVehicles()
      setVehicles(data.vehicles || [])
      setScannedAt(data.scannedAt)
      toast({ title: t('toastCatalogUpdatedTitle'), description: t('toastCatalogUpdatedDesc', { count: data.count || 0 }) })
    } catch (err: unknown) {
      const msg = getUserErrorMessage(err, t('scanFailed'))
      setScanError(msg)
      toast({
        title: t('toastScanFailedTitle'),
        description: msg.includes('Bridge not running')
          ? t('bridgeNotRunning')
          : msg,
        variant: 'destructive',
      })
    } finally {
      setScanning(false)
    }
  }, [scanning, toast, t])

  const { visibleVehicles, totalFiltered, capped, groupedVehicles } = useMemo(() => {
    const q = search.toLowerCase().trim()
    let filtered = vehicles

    if (q) {
      filtered = filtered.filter(
        v => v.id.toLowerCase().includes(q) || v.name.toLowerCase().includes(q)
      )
    }

    filtered = [...filtered].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))

    const total = filtered.length
    const isCapped = total > MAX_VISIBLE
    const visible = isCapped ? filtered.slice(0, MAX_VISIBLE) : filtered

    // Group by type for display
    const groups = new Map<string, CatalogVehicle[]>()
    for (const v of visible) {
      const type = getVehicleType(v)
      if (!groups.has(type)) groups.set(type, [])
      groups.get(type)!.push(v)
    }
    const sorted = Array.from(groups.entries())
      .sort(([a], [b]) => (TYPE_ORDER[a] ?? 99) - (TYPE_ORDER[b] ?? 99))

    return { visibleVehicles: visible, totalFiltered: total, capped: isCapped, groupedVehicles: sorted }
  }, [vehicles, search])

  const selectedVehicle = useMemo(() => vehicles.find(v => v.id === value), [vehicles, value])

  const handleSelect = (id: string) => {
    onChange(id)
    setOpen(false)
    setSearch('')
    setHighlightIndex(-1)
    triggerRef.current?.focus()
  }

  const handleClear = () => {
    onChange('')
    setSearch('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightIndex(prev => Math.min(prev + 1, visibleVehicles.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightIndex(prev => Math.max(prev - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (highlightIndex >= 0 && highlightIndex < visibleVehicles.length) {
          handleSelect(visibleVehicles[highlightIndex].id)
        } else if (visibleVehicles.length > 0) {
          handleSelect(visibleVehicles[0].id)
        }
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        setHighlightIndex(-1)
        triggerRef.current?.focus()
        break
    }
  }

  useEffect(() => {
    if (highlightIndex < 0 || !listRef.current) return
    const el = listRef.current.querySelector(`[data-veh-index="${highlightIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  if (initialLoad) {
    return (
      <div className="flex items-center gap-2 h-11 sm:h-9 rounded-md border border-input bg-background px-3 text-sm">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground shrink-0" />
        <span className="text-muted-foreground truncate">{t('loadingVehicles')}</span>
      </div>
    )
  }

  if (vehicles.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex gap-2">
          <Input
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={t('manualIdPlaceholder')}
            disabled={disabled || scanning}
            className="flex-1 min-w-0"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleScan}
            disabled={scanning || disabled}
            // eslint-disable-next-line local/no-dead-disabled-title -- pure hint describing what Scan needs to succeed, unconditional regardless of disabled state; `disabled` here is a generic pass-through prop no current caller sets, and `scanning` is a self-evident transient busy state (the spinner). Not a disabled-reason. Triaged 2026-08-27, same shape as ItemPicker.tsx.
            title={t('scanTitle')}
            className="shrink-0"
          >
            {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            <span className="ms-1.5 hidden sm:inline">{t('scan')}</span>
          </Button>
        </div>
        {scanError ? (
          <p className="text-[11px] text-destructive flex items-center gap-1">
            <AlertCircle className="w-3 h-3 shrink-0" />
            <span className="truncate">{scanError}</span>
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {scanning ? t('scanningVehicles') : t('enterManuallyOrScan')}
          </p>
        )}
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
      {/* Trigger */}
      <div
        ref={triggerRef}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? 'vehpicker-listbox' : undefined}
        aria-label={t('selectVehicleAria')}
        tabIndex={disabled ? -1 : 0}
        className={cn(
          'flex items-center gap-2 h-11 sm:h-9 rounded-md border border-input bg-background px-3 text-sm cursor-pointer',
          'motion-safe:transition-colors duration-150',
          'hover:border-primary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          open && 'border-primary/60 ring-1 ring-primary/20',
          disabled && 'opacity-50 cursor-not-allowed pointer-events-none'
        )}
        onClick={() => !disabled && setOpen(!open)}
      >
        <Car className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
        {selectedVehicle ? (
          <span className="flex-1 min-w-0 truncate">
            <span className="font-medium">{selectedVehicle.name || selectedVehicle.id}</span>
            {typeof selectedVehicle.seats === 'number' && selectedVehicle.seats > 0 && (
              <span className="inline-flex items-center gap-0.5 text-muted-foreground ms-2 text-xs">
                <Users className="w-3 h-3" />
                {selectedVehicle.seats}
              </span>
            )}
          </span>
        ) : value ? (
          <span className="flex-1 min-w-0 truncate text-foreground">{value.replace('Base.', '')}</span>
        ) : (
          <span className="flex-1 min-w-0 truncate text-muted-foreground">{resolvedPlaceholder}</span>
        )}
        {value && !disabled && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); handleClear() }}
            className="-me-1 flex items-center justify-center w-6 h-6 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring shrink-0 motion-safe:transition-colors"
            aria-label={t('clearSelectionAria')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 text-muted-foreground shrink-0 motion-safe:transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </div>

      {/* Dropdown */}
      {open && (
        <div
          className={cn(
            'absolute z-50 rounded-lg border border-border bg-popover shadow-lg',
            'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-[0.98] motion-safe:duration-150',
            dropUp ? 'bottom-full mb-1 motion-safe:slide-in-from-bottom-1' : 'top-full mt-1 motion-safe:slide-in-from-top-1'
          )}
          style={{ width: 'max(100%, 400px)' }}
        >
          {/* Search */}
          <div className="flex items-center gap-2 border-b border-border px-3 h-11">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('searchNVehiclesPlaceholder', { count: vehicles.length })}
              className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              aria-label={t('filterVehiclesAria')}
              autoFocus
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label={t('clearSearchAria')}
                className="flex items-center justify-center w-5 h-5 rounded text-muted-foreground hover:text-foreground shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={e => { e.stopPropagation(); handleScan() }}
              disabled={scanning}
              className="h-7 w-7 p-0 shrink-0"
              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; disables only while a scan is already in flight (the spinner is the self-evident why). Triaged 2026-08-27.
              title={t('rescanTitle')}
              aria-label={t('rescanTitle')}
            >
              {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            </Button>
          </div>

          {/* Vehicle list — grouped by type */}
          <div className="max-h-[320px] overflow-y-auto overscroll-contain" role="listbox" id="vehpicker-listbox" aria-label={t('vehicleListAria')}>
            {totalFiltered === 0 ? (
              <div className="py-10 text-center text-muted-foreground">
                <SearchX className="w-6 h-6 mx-auto mb-2 opacity-30" />
                <p className="text-sm">
                  {search ? t('noVehiclesMatch', { search }) : t('noVehiclesFound')}
                </p>
              </div>
            ) : (
              <div ref={listRef} className="py-0.5">
                {groupedVehicles.map(([type, vehs]) => (
                  <div key={type}>
                    {/* Group header — only show when not searching */}
                    {!search && groupedVehicles.length > 1 && (() => {
                      const Icon = TYPE_ICON[type] || Car
                      return (
                        <div className="sticky top-0 z-10 flex items-center gap-2 px-3 h-7 bg-muted/50 backdrop-blur-sm text-[11px] text-muted-foreground font-medium border-b border-border/20">
                          <Icon className="w-3 h-3 opacity-50" />
                          {t(`types.${type}`)}
                          <span className="opacity-40 tabular-nums">({vehs.length})</span>
                        </div>
                      )
                    })()}
                    {vehs.map((veh) => {
                      const globalIdx = visibleVehicles.indexOf(veh)
                      return (
                        <button
                          key={veh.id}
                          type="button"
                          role="option"
                          aria-selected={veh.id === value}
                          data-veh-index={globalIdx}
                          onClick={() => handleSelect(veh.id)}
                          className={cn(
                            'w-full flex items-center gap-2.5 px-3 h-9 text-sm text-start',
                            'motion-safe:transition-colors duration-75',
                            'hover:bg-accent/10',
                            veh.id === value && 'bg-primary/10 text-primary',
                            globalIdx === highlightIndex && 'bg-accent/15 outline-none'
                          )}
                        >
                          <span className="flex-1 min-w-0 truncate font-medium">{formatVehicleName(veh)}</span>
                          {typeof veh.seats === 'number' && veh.seats > 0 && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/60 shrink-0 tabular-nums" title={t('seatsTitle', { count: veh.seats })}>
                              <Users className="w-2.5 h-2.5" />
                              {veh.seats}
                            </span>
                          )}
                          {typeof veh.mass === 'number' && veh.mass > 0 && (
                            <span className="text-[10px] text-muted-foreground/40 shrink-0 tabular-nums" title={`${veh.mass}kg`}>
                              {(veh.mass / 1000).toFixed(1)}t
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground/40 shrink-0 max-w-[30%] truncate font-mono">{veh.id.replace('Base.', '')}</span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-border/40 px-3 h-8 flex items-center justify-between gap-3 text-[11px] text-muted-foreground bg-card/30">
            <span className="shrink-0 tabular-nums">
              {capped
                ? (
                  <Trans
                    i18nKey="cappedFooter"
                    t={t}
                    values={{ max: MAX_VISIBLE, total: totalFiltered }}
                    components={{ 1: <span className="text-warning" /> }}
                  />
                )
                : t('vehiclesCount', { count: totalFiltered })}
            </span>
            <div className="flex items-center gap-3 text-[10px] opacity-60">
              <span>{t('navigateHint')}</span>
              <span>{t('selectHint')}</span>
              <span>{t('closeHint')}</span>
            </div>
            {scannedAt && (
              <span className="truncate text-end opacity-50">
                {new Date(scannedAt).toLocaleDateString(i18n.language)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
