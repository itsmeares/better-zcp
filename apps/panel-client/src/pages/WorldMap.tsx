import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LngLatBounds, Map as MapLibreMap, setWorkerUrl, type GeoJSONSource, type LngLat, type PointLike } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { Link, useSearch } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowUpRight,
  Biohazard,
  ChevronDown,
  ChevronUp,
  Copy,
  Heart,
  Loader2,
  Locate,
  Map as MapIcon,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Users,
  X,
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useSocket } from '@/contexts/SocketContext'
import { useToast } from '@/components/ui/use-toast'
import {
  gameIntegrationApi,
  mapApi,
  playersApi,
  serversApi,
  type WorldMapManifest,
  type WorldMapPoint,
  type WorldMapSearchResult,
} from '@/lib/api'
import { getAccessToken } from '@/lib/authToken'
import { createInFlightGate } from '@/lib/inFlightGate'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { cn, copyText } from '@/lib/utils'
import { fromLngLat, toLngLat } from './worldMap/coords'
import {
  EMPTY,
  applyFloorStyle,
  createMapStyle,
  densityToLngLat,
  featuresToLngLat,
  roomsToLngLat,
} from './worldMap/mapStyle'

setWorkerUrl(workerUrl)

const PLAYER_POLL_MS = 3000
const MOVE_MS = 450
const CELL = 256
const DENSITY_KEY = 'worldMap.density'

interface MapPlayer extends WorldMapPoint {
  username: string
  displayName: string
  health?: number
  isAlive?: boolean
  isInfected?: boolean
  accessLevel?: string
  hunger?: number
  thirst?: number
  fatigue?: number
  previousX: number
  previousY: number
  movedAt: number
}

interface ContextMenu {
  left: number
  top: number
  point: WorldMapPoint
  player?: MapPlayer
}

const isStaff = (player: MapPlayer) => !!player.accessLevel && !['none', 'user'].includes(player.accessLevel)

function playerState(player: MapPlayer): string {
  if (player.isAlive === false) return 'dead'
  if (player.isInfected) return 'infected'
  return isStaff(player) ? 'staff' : 'normal'
}

function interpolate(player: MapPlayer, now: number): { x: number; y: number } {
  const progress = Math.max(0, Math.min(1, (now - player.movedAt) / MOVE_MS))
  const eased = 1 - Math.pow(1 - progress, 3)
  return {
    x: player.previousX + (player.x - player.previousX) * eased,
    y: player.previousY + (player.y - player.previousY) * eased,
  }
}

const floorName = (floor: number) => (floor === 0 ? 'Ground floor' : floor < 0 ? `Basement ${-floor}` : `Floor ${floor}`)

export default function WorldMap() {
  const socket = useSocket()
  const { toast } = useToast()
  const confirm = useConfirm()
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>

  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const manifestRef = useRef<WorldMapManifest | null>(null)
  const floorRef = useRef(Number.isInteger(routeSearch.z) ? (routeSearch.z as number) : 0)
  const playersRef = useRef<MapPlayer[]>([])
  const selectedRef = useRef<string | null>(null)
  const roomsCacheRef = useRef(new Map<string, Promise<ReturnType<typeof roomsToLngLat>>>())
  const densityLoadedRef = useRef<string | null>(null)
  const playersGateRef = useRef(createInFlightGate())
  const generationRef = useRef(0)
  const serverProfileRef = useRef(routeSearch.server)

  const [manifest, setManifest] = useState<WorldMapManifest | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const mapReadyRef = useRef(false)
  const [mapError, setMapError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [floor, setFloorState] = useState(floorRef.current)
  const [density, setDensity] = useState(() => localStorage.getItem(DENSITY_KEY) === '1')
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [center, setCenter] = useState<{ x: number; y: number } | null>(null)
  const [hasActiveServer, setHasActiveServer] = useState(false)
  const [integrationConnected, setIntegrationConnected] = useState(false)
  const [players, setPlayers] = useState<MapPlayer[]>([])
  const [rosterOpen, setRosterOpen] = useState(false)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WorldMapSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [activeResult, setActiveResult] = useState(0)
  const [warningsOpen, setWarningsOpen] = useState(false)

  manifestRef.current = manifest
  playersRef.current = players
  selectedRef.current = selectedName
  const selectedPlayer = players.find((player) => player.username === selectedName) ?? null

  // ---------- data ----------

  const loadManifest = useCallback(async () => {
    const generation = ++generationRef.current
    setLoading(true)
    setMapError(null)
    try {
      const next = await mapApi.manifest()
      if (generation !== generationRef.current) return
      roomsCacheRef.current.clear()
      densityLoadedRef.current = null
      setManifest((previous) => (previous?.key === next.key ? previous : next))
      if (next.folders.length === 0) setMapError(next.warnings.join(' ') || 'No map files were found for this server.')
    } catch (error) {
      if (generation === generationRef.current) setMapError(getUserErrorMessage(error, 'The map data could not be loaded.'))
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [])

  const refreshActiveServer = useCallback(async () => {
    try {
      setHasActiveServer(!!(await serversApi.getResolvedActive()).server)
    } catch {
      setHasActiveServer(false)
    }
  }, [])

  const fetchPlayers = useCallback(async () => {
    if (!hasActiveServer) {
      setPlayers([])
      setIntegrationConnected(false)
      return
    }
    if (!playersGateRef.current.enter()) return
    const generation = generationRef.current
    try {
      const response = await gameIntegrationApi.getServerInfo()
      if (generation !== generationRef.current) return
      const raw = response.success ? response.data?.players ?? [] : null
      setIntegrationConnected(raw !== null)
      setPlayers((previous) => {
        if (!raw) return []
        const byName = new Map(previous.map((player) => [player.username, player]))
        const now = performance.now()
        return raw.flatMap((player) => {
          if (typeof player.username !== 'string' || typeof player.x !== 'number' || typeof player.y !== 'number' || !Number.isFinite(player.x + player.y)) return []
          const old = byName.get(player.username)
          const moved = !!old && (old.x !== player.x || old.y !== player.y)
          const from = old ? interpolate(old, now) : { x: player.x, y: player.y }
          return [{
            username: player.username,
            displayName: player.displayName || player.username,
            x: player.x,
            y: player.y,
            z: typeof player.z === 'number' && Number.isFinite(player.z) ? Math.round(player.z) : 0,
            health: player.health?.overallBodyHealth,
            isAlive: player.isAlive,
            isInfected: player.health?.isInfected,
            accessLevel: player.accessLevel,
            hunger: player.stats?.hunger,
            thirst: player.stats?.thirst,
            fatigue: player.stats?.fatigue,
            previousX: moved ? from.x : player.x,
            previousY: moved ? from.y : player.y,
            movedAt: moved ? now : now - MOVE_MS,
          }]
        })
      })
    } catch {
      if (generation === generationRef.current) {
        setPlayers([])
        setIntegrationConnected(false)
      }
    } finally {
      playersGateRef.current.leave()
    }
  }, [hasActiveServer])

  const resetForServerChange = useCallback(() => {
    generationRef.current++
    setPlayers([])
    setSelectedName(null)
    setContextMenu(null)
    setQuery('')
    setResults([])
    void refreshActiveServer()
    void loadManifest()
  }, [loadManifest, refreshActiveServer])

  useEffect(() => {
    void loadManifest()
    void refreshActiveServer()
  }, [loadManifest, refreshActiveServer])

  useEffect(() => {
    if (!socket) return
    socket.on('servers:changed', resetForServerChange)
    return () => {
      socket.off('servers:changed', resetForServerChange)
    }
  }, [socket, resetForServerChange])

  useEffect(() => {
    if (serverProfileRef.current === routeSearch.server) return
    serverProfileRef.current = routeSearch.server
    resetForServerChange()
  }, [routeSearch.server, resetForServerChange])

  useEffect(() => {
    void fetchPlayers()
    if (!hasActiveServer) return
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void fetchPlayers()
    }, PLAYER_POLL_MS)
    return () => window.clearInterval(interval)
  }, [fetchPlayers, hasActiveServer])

  // ---------- map ----------

  const source = useCallback((id: string) => mapRef.current?.getSource(id) as GeoJSONSource | undefined, [])

  const drawPlayers = useCallback(() => {
    const now = performance.now()
    source('players')?.setData({
      type: 'FeatureCollection',
      features: playersRef.current.map((player) => {
        const { x, y } = interpolate(player, now)
        const here = player.z === floorRef.current
        return {
          type: 'Feature' as const,
          properties: {
            name: player.username,
            label: here ? player.displayName : `${player.displayName} · ${player.z > 0 ? '+' : ''}${player.z}`,
            state: playerState(player),
            here,
            selected: player.username === selectedRef.current,
          },
          geometry: { type: 'Point' as const, coordinates: toLngLat(x, y) },
        }
      }),
    })
  }, [source])

  const showFloor = useCallback(async (next: number) => {
    const map = mapRef.current
    const current = manifestRef.current
    if (!map || !current || !mapReadyRef.current) return
    applyFloorStyle(map, current, next)
    drawPlayers()
    const cacheKey = `${current.key}:${next}`
    let rooms = roomsCacheRef.current.get(cacheKey)
    if (!rooms) {
      rooms = mapApi.rooms(current.key, next).then(roomsToLngLat)
      roomsCacheRef.current.set(cacheKey, rooms)
      rooms.catch(() => roomsCacheRef.current.delete(cacheKey))
    }
    try {
      const data = await rooms
      if (mapRef.current === map && floorRef.current === next) source('rooms')?.setData(data)
    } catch (error) {
      toast({ title: 'Rooms could not be loaded', description: getUserErrorMessage(error, 'Try again in a moment.'), variant: 'destructive' })
    }
  }, [drawPlayers, source, toast])

  const setFloor = useCallback((value: number) => {
    const range = manifestRef.current?.floors ?? { min: 0, max: 0 }
    const next = Math.max(range.min, Math.min(range.max, value))
    if (next === floorRef.current) return
    floorRef.current = next
    setFloorState(next)
    setContextMenu(null)
    void showFloor(next)
  }, [showFloor])

  const flyTo = useCallback((point: { x: number; y: number }, zoom?: number) => {
    const map = mapRef.current
    if (!map) return
    map.flyTo({ center: toLngLat(point.x, point.y), zoom: Math.max(map.getZoom(), zoom ?? 9.5), speed: 1.6 })
  }, [])

  // Create the map once per manifest. Everything else updates its sources.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !manifest || manifest.folders.length === 0) return
    const bounds = manifest.bounds ?? [0, 0, CELL, CELL]
    const map = new MapLibreMap({
      container,
      style: createMapStyle(manifest, (folder) => mapApi.tileUrl(manifest.key, folder)),
      center: toLngLat((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2),
      zoom: 3,
      minZoom: 2,
      maxZoom: 12,
      renderWorldCopies: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: false,
      transformRequest: (url) => {
        const token = getAccessToken()
        // Only panel requests carry the token; tile URLs arrive relative.
        return token && new URL(url, window.location.href).origin === window.location.origin
          ? { url, headers: { Authorization: `Bearer ${token}` } }
          : { url }
      },
    })
    map.touchZoomRotate.disableRotation()
    mapRef.current = map

    const pointAt = (lngLat: LngLat) => fromLngLat(lngLat.lng, lngLat.lat)
    const playerAt = (point: PointLike) => {
      const hit = map.queryRenderedFeatures(point, { layers: ['players'] })[0]
      return hit ? playersRef.current.find((player) => player.username === hit.properties.name) : undefined
    }

    map.on('load', () => {
      mapReadyRef.current = true
      setMapReady(true)
      void mapApi.features(manifest.key).then((data) => source('features')?.setData(featuresToLngLat(data))).catch((error) => {
        toast({ title: 'Map labels could not be loaded', description: getUserErrorMessage(error, 'Try reloading the map.'), variant: 'destructive' })
      })
      void showFloor(floorRef.current)
      const shared = routeSearch
      if (typeof shared.x === 'number' && typeof shared.y === 'number') {
        map.jumpTo({ center: toLngLat(shared.x, shared.y), zoom: typeof shared.zoom === 'number' ? shared.zoom : 9.5 })
      } else {
        map.fitBounds([toLngLat(bounds[0], bounds[3]), toLngLat(bounds[2], bounds[1])], { padding: 24, animate: false })
      }
      setCenter(pointAt(map.getCenter()))
    })
    map.on('moveend', () => setCenter(pointAt(map.getCenter())))
    map.on('mousemove', (event) => {
      setCursor(pointAt(event.lngLat))
      map.getCanvas().style.cursor = playerAt(event.point) ? 'pointer' : ''
    })
    map.on('mouseout', () => setCursor(null))
    map.on('click', (event) => {
      setContextMenu(null)
      setSelectedName(playerAt(event.point)?.username ?? null)
    })
    map.on('contextmenu', (event) => {
      const { x, y } = pointAt(event.lngLat)
      setContextMenu({
        left: event.point.x,
        top: event.point.y,
        point: { x, y, z: floorRef.current },
        player: playerAt(event.point),
      })
    })
    map.on('movestart', () => setContextMenu(null))

    // Shift + wheel changes floor instead of zooming, like the in-game map.
    const wheel = (event: WheelEvent) => {
      if (!event.shiftKey) return
      event.preventDefault()
      event.stopPropagation()
      setFloor(floorRef.current + (event.deltaY < 0 ? 1 : -1))
    }
    container.addEventListener('wheel', wheel, { capture: true, passive: false })
    return () => {
      container.removeEventListener('wheel', wheel, { capture: true })
      if (mapRef.current === map) mapRef.current = null
      mapReadyRef.current = false
      setMapReady(false)
      map.remove()
    }
    // routeSearch is read once for the initial view; later changes come from the map itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, setFloor, showFloor, source, toast])

  useEffect(() => {
    const map = mapRef.current
    const current = manifest
    if (!map || !current || !mapReady) return
    map.setLayoutProperty('density', 'visibility', density ? 'visible' : 'none')
    if (!density || densityLoadedRef.current === current.key) return
    densityLoadedRef.current = current.key
    mapApi.density(current.key).then((data) => source('density')?.setData(densityToLngLat(data))).catch((error) => {
      densityLoadedRef.current = null
      toast({ title: 'Zombie density could not be loaded', description: getUserErrorMessage(error, 'Try again in a moment.'), variant: 'destructive' })
    })
  }, [density, manifest, mapReady, source, toast])

  useEffect(() => {
    localStorage.setItem(DENSITY_KEY, density ? '1' : '0')
  }, [density])

  // Animate moved players toward their new position, then stop redrawing.
  useEffect(() => {
    let frame = 0
    const step = () => {
      drawPlayers()
      if (playersRef.current.some((player) => performance.now() - player.movedAt < MOVE_MS)) frame = requestAnimationFrame(step)
    }
    step()
    return () => cancelAnimationFrame(frame)
  }, [players, selectedName, drawPlayers])

  // ---------- search ----------

  useEffect(() => {
    const current = manifest
    const text = query.trim()
    if (!current || text.length < 2) {
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = window.setTimeout(() => {
      const center = mapRef.current?.getCenter()
      const near = center ? fromLngLat(center.lng, center.lat) : { x: 0, y: 0 }
      mapApi.search(current.key, text, near).then(({ results: next }) => {
        setResults(next)
        setActiveResult(0)
      }).catch(() => setResults([])).finally(() => setSearching(false))
    }, 150)
    return () => window.clearTimeout(timer)
  }, [query, manifest])

  const pickResult = useCallback((result: WorldMapSearchResult) => {
    setQuery(result.label)
    setResults([])
    setFloor(result.z)
    source('highlight')?.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: toLngLat(result.x, result.y) } }],
    })
    flyTo(result, { town: 8, place: 9, street: 9.5, building: 10.5, room: 10.5 }[result.kind])
    searchInputRef.current?.blur()
  }, [flyTo, setFloor, source])

  const clearSearch = useCallback(() => {
    setQuery('')
    setResults([])
    source('highlight')?.setData(EMPTY)
  }, [source])

  // ---------- keyboard ----------

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key === 'Escape') {
        setContextMenu(null)
        setSelectedName(null)
        setRosterOpen(false)
        return
      }
      if (target?.closest('input, textarea, select, [contenteditable="true"]') || event.ctrlKey || event.metaKey || event.altKey) return
      if (!containerRef.current?.isConnected) return
      if (event.key === ',') setFloor(floorRef.current - 1)
      else if (event.key === '.') setFloor(floorRef.current + 1)
      else if (event.key === '/') {
        event.preventDefault()
        searchInputRef.current?.focus()
      } else return
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [setFloor])

  // ---------- actions ----------

  const viewCenter = () => {
    const center = mapRef.current?.getCenter()
    return center ? fromLngLat(center.lng, center.lat) : null
  }

  const copyLink = useCallback(async () => {
    const center = viewCenter()
    const map = mapRef.current
    if (!center || !map) return
    const url = new URL(window.location.href)
    url.searchParams.set('x', String(Math.round(center.x)))
    url.searchParams.set('y', String(Math.round(center.y)))
    url.searchParams.set('z', String(floorRef.current))
    url.searchParams.set('zoom', map.getZoom().toFixed(1))
    const ok = await copyText(url.toString())
    toast(ok ? { title: 'Map link copied' } : { title: 'Copy failed', description: 'Clipboard unavailable', variant: 'destructive' })
  }, [toast])

  const copyCoordinates = useCallback(async (point: WorldMapPoint) => {
    const text = `${Math.round(point.x)}, ${Math.round(point.y)}, ${point.z}`
    const ok = await copyText(text)
    toast(ok ? { title: 'Coordinates copied', description: text } : { title: 'Copy failed', description: 'Clipboard unavailable', variant: 'destructive' })
    setContextMenu(null)
  }, [toast])

  const fitToPlayers = useCallback(() => {
    const map = mapRef.current
    const online = playersRef.current
    if (!map || online.length === 0) return
    if (online.length === 1) return flyTo(online[0], 9.5)
    const box = new LngLatBounds()
    for (const player of online) box.extend(toLngLat(player.x, player.y))
    map.fitBounds(box, { padding: 80, maxZoom: 10 })
  }, [flyTo])

  const focusPlayer = useCallback((player: MapPlayer) => {
    setSelectedName(player.username)
    setRosterOpen(false)
    setFloor(player.z)
    flyTo(player)
  }, [flyTo, setFloor])

  const healPlayer = useCallback(async (username: string) => {
    setActionLoading(`heal:${username}`)
    setContextMenu(null)
    try {
      const result = await gameIntegrationApi.healPlayer(username)
      if (!result.success) throw new Error(result.error || 'Heal failed.')
      toast({ title: 'Player healed', description: username })
      void fetchPlayers()
    } catch (error) {
      toast({ title: 'Heal failed', description: getUserErrorMessage(error, 'Could not heal player.'), variant: 'destructive' })
    } finally {
      setActionLoading(null)
    }
  }, [fetchPlayers, toast])

  const enableGodMode = useCallback(async (username: string) => {
    setActionLoading(`god:${username}`)
    try {
      await playersApi.setGodMode(username, true)
      toast({ title: 'God mode enabled', description: username })
    } catch (error) {
      toast({ title: 'God mode failed', description: getUserErrorMessage(error, 'Could not enable god mode.'), variant: 'destructive' })
    } finally {
      setActionLoading(null)
    }
  }, [toast])

  const teleportPlayer = useCallback(async (username: string, point: WorldMapPoint) => {
    setContextMenu(null)
    const target = { x: Math.round(point.x), y: Math.round(point.y), z: point.z }
    const accepted = await confirm({
      title: `Teleport ${username}?`,
      description: `Move ${username} to ${target.x}, ${target.y} on ${floorName(target.z).toLowerCase()}.`,
      confirmLabel: 'Teleport player',
      variant: 'warning',
    })
    if (!accepted) return
    setActionLoading(`teleport:${username}`)
    try {
      await playersApi.teleport(username, target)
      toast({ title: 'Player teleported', description: `${username} → ${target.x}, ${target.y}, ${target.z}` })
      void fetchPlayers()
    } catch (error) {
      toast({ title: 'Teleport failed', description: getUserErrorMessage(error, 'Could not teleport player.'), variant: 'destructive' })
    } finally {
      setActionLoading(null)
    }
  }, [confirm, fetchPlayers, toast])

  // ---------- render ----------

  const readout = cursor ?? center
  const floorRange = manifest?.floors ?? { min: 0, max: 0 }
  const menuFlip = useMemo(() => {
    const box = containerRef.current?.getBoundingClientRect()
    return contextMenu && box
      ? { x: contextMenu.left > box.width / 2, y: contextMenu.top > box.height / 2 }
      : { x: false, y: false }
  }, [contextMenu])

  return (
    <div className="space-y-4 page-transition">
      <PageHeader
        title="World Map"
        description="Right-click the map to move or heal players."
        icon={<MapIcon className="h-5 w-5" />}
        tone="world"
      />

      <div className="relative overflow-hidden rounded-md border border-border/60 bg-[#14130f]" style={{ height: 'calc(100vh - 180px)', minHeight: 480 }}>
        <div ref={containerRef} className="h-full w-full" role="application" aria-label="World map. Drag to pan, scroll to zoom, comma and period change floor." />

        {(loading || mapError) && (
          <div className="absolute inset-0 z-20 flex items-center justify-center p-6" role={mapError ? 'alert' : 'status'}>
            {mapError ? (
              <div className="max-w-md rounded-lg border border-border/60 bg-card/95 p-5 text-center shadow-xl">
                <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-warning" />
                <p className="text-sm font-medium text-foreground">The map could not be shown</p>
                <p className="mt-1 text-sm text-muted-foreground">{mapError}</p>
                <Button size="sm" variant="outline" className="mt-4 gap-2" onClick={() => void loadManifest()}>
                  <RefreshCw className="h-4 w-4" />Try again
                </Button>
              </div>
            ) : (
              <span className="flex items-center gap-2 rounded-full bg-black/60 px-4 py-2 text-sm text-white/80"><Loader2 className="h-4 w-4 animate-spin" />Loading map</span>
            )}
          </div>
        )}

        {manifest && !mapError && <>
          {/* Search */}
          <div className="absolute left-1/2 top-3 z-10 w-[min(26rem,calc(100%-7rem))] -translate-x-1/2">
            <label className="map-glass flex h-11 items-center gap-2 rounded-full px-4">
              {searching ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-white/60" /> : <Search className="h-4 w-4 shrink-0 text-white/60" />}
              <input
                ref={searchInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') { event.preventDefault(); setActiveResult((index) => Math.min(results.length - 1, index + 1)) }
                  else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveResult((index) => Math.max(0, index - 1)) }
                  else if (event.key === 'Enter' && results[activeResult]) pickResult(results[activeResult])
                  else if (event.key === 'Escape') { clearSearch(); event.currentTarget.blur() }
                }}
                placeholder="Search towns, streets, buildings and rooms"
                aria-label="Search the map"
                className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-white/45 focus:outline-hidden"
              />
              {query && <button type="button" onClick={clearSearch} aria-label="Clear search" className="rounded-full p-1 text-white/60 hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button>}
            </label>
            {results.length > 0 && (
              <ul className="map-glass mt-2 max-h-80 overflow-y-auto rounded-xl py-1" role="listbox" aria-label="Search results">
                {results.map((result, index) => (
                  <li key={`${result.kind}:${result.label}:${result.x}:${result.y}:${result.z}`} role="option" aria-selected={index === activeResult}>
                    <button
                      type="button"
                      onMouseEnter={() => setActiveResult(index)}
                      onClick={() => pickResult(result)}
                      className={cn('flex w-full items-baseline justify-between gap-3 px-4 py-2 text-start text-sm text-white/90', index === activeResult && 'bg-white/10')}
                    >
                      <span className="truncate first-letter:uppercase">{result.label}</span>
                      <span className="shrink-0 text-xs text-white/50">{[result.kind === 'room' && floorName(result.z), result.area].filter(Boolean).join(' · ')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Players */}
          {players.length > 0 && (
            <div className="absolute left-3 top-3 z-10 w-56">
              <button type="button" onClick={() => setRosterOpen((open) => !open)} aria-expanded={rosterOpen} className="map-glass flex h-11 items-center gap-2 rounded-full px-4 text-sm text-white/90">
                <Users className="h-4 w-4 text-white/60" />{players.length} online{rosterOpen ? <ChevronUp className="h-3.5 w-3.5 text-white/50" /> : <ChevronDown className="h-3.5 w-3.5 text-white/50" />}
              </button>
              {rosterOpen && (
                <ul className="map-glass mt-2 max-h-72 overflow-y-auto rounded-xl py-1">
                  {players.map((player) => (
                    <li key={player.username}>
                      <button type="button" onClick={() => focusPlayer(player)} className="flex w-full items-center gap-2 px-4 py-2 text-start text-sm text-white/90 hover:bg-white/10">
                        <span className={cn('h-2 w-2 shrink-0 rounded-full', { dead: 'bg-stone-400', infected: 'bg-red-400', staff: 'bg-amber-400', normal: 'bg-sky-400' }[playerState(player)])} />
                        <span className="flex-1 truncate">{player.displayName}</span>
                        {player.z !== 0 && <span className="text-xs text-white/50">{player.z > 0 ? `+${player.z}` : player.z}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Zoom and layers */}
          <div className="absolute right-3 top-1/2 z-10 flex -translate-y-full flex-col gap-2">
            <div className="map-glass flex flex-col rounded-full p-1">
              <MapButton label="Zoom in" onClick={() => mapRef.current?.zoomIn()}><Plus className="h-4 w-4" /></MapButton>
              <MapButton label="Zoom out" onClick={() => mapRef.current?.zoomOut()}><Minus className="h-4 w-4" /></MapButton>
              {players.length > 0 && <MapButton label="Show all players" onClick={fitToPlayers}><Locate className="h-4 w-4" /></MapButton>}
            </div>
            <div className="map-glass flex flex-col rounded-full p-1">
              <MapButton label={density ? 'Hide zombie density' : 'Show zombie density'} pressed={density} onClick={() => setDensity((value) => !value)}>
                <Biohazard className="h-4 w-4" />
              </MapButton>
            </div>
          </div>

          {/* Floor */}
          <div className="absolute bottom-16 right-3 z-10">
            <div className="map-glass flex flex-col items-center rounded-full p-1" role="group" aria-label={`Floor: ${floorName(floor)}`}>
              <MapButton label="Floor up" disabled={floor >= floorRange.max} onClick={() => setFloor(floor + 1)}><ChevronUp className="h-4 w-4" /></MapButton>
              <button type="button" onClick={() => setFloor(0)} title={`${floorName(floor)} (, and . change floor)`} className={cn('flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold tabular-nums', floor === 0 ? 'text-white' : 'bg-primary text-primary-foreground')}>
                {floor > 0 ? `+${floor}` : floor}
              </button>
              <MapButton label="Floor down" disabled={floor <= floorRange.min} onClick={() => setFloor(floor - 1)}><ChevronDown className="h-4 w-4" /></MapButton>
            </div>
          </div>

          {/* Coordinates */}
          {readout && (
            <button type="button" onClick={() => void copyLink()} title="Copy a link to this view" className="map-glass absolute bottom-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full px-4 py-2 text-xs tabular-nums text-white/70 hover:text-white">
              <span className="font-semibold text-white">{Math.floor(readout.x)} × {Math.floor(readout.y)}</span>
              <span className="mx-2 text-white/30">·</span>Cell {Math.floor(readout.x / CELL)},{Math.floor(readout.y / CELL)}
              <span className="mx-2 text-white/30">·</span>{floorName(floor)}
            </button>
          )}

          {/* Warnings */}
          {manifest.warnings.length > 0 && (
            <div className="absolute bottom-3 left-3 z-10 max-w-[min(22rem,calc(50%-6rem))]">
              {warningsOpen && (
                <ul className="map-glass mb-2 space-y-1 rounded-xl px-4 py-3 text-xs text-white/80">
                  {manifest.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              )}
              <button type="button" onClick={() => setWarningsOpen((open) => !open)} aria-expanded={warningsOpen} className="map-glass flex items-center gap-2 rounded-full px-3 py-2 text-xs text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" />{manifest.warnings.length === 1 ? '1 map warning' : `${manifest.warnings.length} map warnings`}
              </button>
            </div>
          )}

          {/* Player card */}
          {selectedPlayer && (
            <div className="map-glass absolute bottom-16 right-16 z-10 w-64 rounded-xl p-4 text-sm text-white/90">
              <div className="mb-3 flex items-center gap-2">
                <span className="flex-1 truncate font-semibold text-white">{selectedPlayer.displayName}</span>
                <button type="button" onClick={() => setSelectedName(null)} aria-label="Close player details" className="rounded-full p-1 text-white/60 hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button>
              </div>
              <dl className="space-y-1.5 text-xs">
                <Stat label="Position" value={`${Math.round(selectedPlayer.x)}, ${Math.round(selectedPlayer.y)} · ${floorName(selectedPlayer.z)}`} />
                {selectedPlayer.isAlive === false && <Stat label="Status" value="Dead" />}
                {selectedPlayer.isInfected && <Stat label="Status" value="Infected" tone="text-red-300" />}
                {isStaff(selectedPlayer) && <Stat label="Role" value={selectedPlayer.accessLevel!} />}
                {selectedPlayer.health !== undefined && <Bar label="Health" value={selectedPlayer.health} good="high" />}
                {selectedPlayer.hunger !== undefined && <Bar label="Hunger" value={selectedPlayer.hunger * 100} good="low" />}
                {selectedPlayer.thirst !== undefined && <Bar label="Thirst" value={selectedPlayer.thirst * 100} good="low" />}
                {selectedPlayer.fatigue !== undefined && <Bar label="Fatigue" value={selectedPlayer.fatigue * 100} good="low" />}
              </dl>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button size="sm" variant="secondary" className="gap-1.5" disabled={actionLoading !== null || !integrationConnected} onClick={() => void healPlayer(selectedPlayer.username)}>
                  {actionLoading === `heal:${selectedPlayer.username}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Heart className="h-3.5 w-3.5" />}Heal
                </Button>
                <Button size="sm" variant="secondary" className="gap-1.5" disabled={actionLoading !== null} onClick={() => void enableGodMode(selectedPlayer.username)}>
                  {actionLoading === `god:${selectedPlayer.username}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shield className="h-3.5 w-3.5" />}God mode
                </Button>
              </div>
              <Link to="/players" search={{ player: selectedPlayer.username }} className="mt-2 flex items-center justify-center gap-1 rounded-md py-1.5 text-xs text-white/60 hover:bg-white/10 hover:text-white">
                Open in Players<ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          )}

          {/* Context menu */}
          {contextMenu && (
            <div
              ref={(element) => element?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()}
              role="menu"
              aria-label="Map actions"
              className="map-glass absolute z-20 min-w-56 rounded-xl py-1 text-sm text-white/90"
              style={{
                left: contextMenu.left,
                top: contextMenu.top,
                transform: `translate(${menuFlip.x ? '-100%' : '0'}, ${menuFlip.y ? '-100%' : '0'})`,
              }}
              onKeyDown={(event) => {
                const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
                const index = items.indexOf(document.activeElement as HTMLButtonElement)
                if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length]?.focus() }
                else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus() }
              }}
            >
              <MenuItem onClick={() => void copyCoordinates(contextMenu.point)} icon={<Copy className="h-4 w-4" />}>
                Copy {Math.round(contextMenu.point.x)}, {Math.round(contextMenu.point.y)}, {contextMenu.point.z}
              </MenuItem>
              {contextMenu.player && (
                <MenuItem disabled={actionLoading !== null || !integrationConnected} onClick={() => void healPlayer(contextMenu.player!.username)} icon={<Heart className="h-4 w-4" />}>
                  Heal {contextMenu.player.displayName}
                </MenuItem>
              )}
              {players.length > 0 && <>
                <div className="mx-3 my-1 border-t border-white/10" />
                <p className="px-4 pb-1 pt-1.5 text-xs text-white/50">Teleport here</p>
                {players.slice(0, 8).map((player) => (
                  <MenuItem key={player.username} disabled={actionLoading !== null || !integrationConnected} onClick={() => void teleportPlayer(player.username, contextMenu.point)} icon={<Users className="h-4 w-4" />}>
                    {player.displayName}
                  </MenuItem>
                ))}
              </>}
            </div>
          )}
        </>}
      </div>
    </div>
  )
}

function MapButton({ label, onClick, disabled, pressed, children }: {
  label: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-full text-white/75 transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-30',
        pressed && 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
      )}
    >
      {children}
    </button>
  )
}

function MenuItem({ icon, onClick, disabled, children }: { icon: React.ReactNode; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} disabled={disabled} className="flex w-full items-center gap-3 px-4 py-2 text-start hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-hidden disabled:opacity-40">
      <span className="text-white/60">{icon}</span><span className="truncate">{children}</span>
    </button>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-white/50">{label}</dt><dd className={cn('truncate tabular-nums', tone)}>{value}</dd></div>
}

function Bar({ label, value, good }: { label: string; value: number; good: 'high' | 'low' }) {
  const amount = Math.max(0, Math.min(100, value))
  const score = good === 'high' ? amount : 100 - amount
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-white/50">{label}</dt>
      <dd className="flex items-center gap-2">
        <span className="h-1.5 w-20 overflow-hidden rounded-full bg-white/10">
          <span className={cn('block h-full rounded-full', score > 50 ? 'bg-emerald-400' : score > 25 ? 'bg-amber-400' : 'bg-red-400')} style={{ width: `${amount}%` }} />
        </span>
        <span className="w-8 text-end tabular-nums">{Math.round(amount)}%</span>
      </dd>
    </div>
  )
}
