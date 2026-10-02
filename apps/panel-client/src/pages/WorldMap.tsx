import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import OpenSeadragon from 'openseadragon'
import { Link, useSearch } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Copy,
  Crosshair,
  Heart,
  Layers,
  Loader2,
  Locate,
  Map as MapIcon,
  MapPin,
  Maximize2,
  PackageSearch,
  RefreshCw,
  Search,
  Shield,
  Users,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { GameIntegrationStatusBadge } from '@/components/GameIntegrationStatusBadge'
import { HelpTip } from '@/components/HelpTip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useSocket } from '@/contexts/SocketContext'
import { useTheme } from '@/contexts/ThemeContext'
import { useToast } from '@/components/ui/use-toast'
import {
  gameIntegrationApi,
  mapApi,
  playersApi,
  serversApi,
  type WorldMapInfo,
  type WorldMapLayer,
  type WorldMapPoint,
  type WorldMapPoi,
} from '@/lib/api'
import { createInFlightGate } from '@/lib/inFlightGate'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { cn, copyText } from '@/lib/utils'
import {
  availableTileFloors,
  buildTileUrl,
  indexLayerCoverage,
  imageToWorld,
  layerClipPolygons,
  layersForFloor,
  mapFloorRange,
  mapCoverageIsValid,
  mapMetadataIsValid,
  normalizeMapSearch,
  placeLayer,
  tileFloorFor,
  worldToImage,
  type LayerCoverageLookup,
} from './worldMapHelpers'

const PLAYER_POLL_MS = 3000
const MIN_MARKER_HIT_RADIUS = 14

interface MapPlayer extends WorldMapPoint {
  username: string
  displayName?: string
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
  x: number
  y: number
  point: WorldMapPoint
  player?: MapPlayer
}

interface LootResult {
  point: WorldMapPoint
  type: string
  locations: WorldMapPoint[]
  truncated: boolean
}

interface LayerCoverage {
  ground: number
  tiles: LayerCoverageLookup
}

interface TileLoadStatus {
  generation: number
  failures: number
  successes: number
  timer: number | null
}

function floorLabel(floor: number): string {
  return floor === 0 ? 'Ground' : floor > 0 ? `Floor ${floor}` : `B${Math.abs(floor)}`
}

function getPlayerColor(player: MapPlayer, alpha = 1): string {
  return `hsl(var(${playerColorToken(player)}) / ${alpha})`
}

function playerColorToken(player: MapPlayer): string {
  if (player.isAlive === false) return '--muted-foreground'
  if (player.isInfected) return '--destructive'
  if (player.accessLevel && player.accessLevel !== 'none' && player.accessLevel !== 'user') {
    return '--warning'
  }
  return '--info'
}

function referenceLayer(info: WorldMapInfo | null): WorldMapLayer | null {
  return info?.layers.find((layer) => layer.id === 'base') ?? info?.layers[0] ?? null
}

function interpolatePlayer(player: MapPlayer, now: number): WorldMapPoint {
  const progress = Math.max(0, Math.min(1, (now - player.movedAt) / 450))
  const eased = 1 - Math.pow(1 - progress, 3)
  return {
    x: player.previousX + (player.x - player.previousX) * eased,
    y: player.previousY + (player.y - player.previousY) * eased,
    z: player.z,
  }
}

export default function WorldMap() {
  const socket = useSocket()
  const { theme } = useTheme()
  const { toast } = useToast()
  const confirm = useConfirm()
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>
  const sharedPoint = useMemo(() => {
    const x = typeof routeSearch.x === 'number' ? routeSearch.x : Number(routeSearch.x)
    const y = typeof routeSearch.y === 'number' ? routeSearch.y : Number(routeSearch.y)
    const z = typeof routeSearch.z === 'number' ? routeSearch.z : Number(routeSearch.z)
    return Number.isFinite(x) && Number.isFinite(y)
      ? { x, y, z: Number.isInteger(z) ? z : 0 }
      : null
  }, [routeSearch.x, routeSearch.y, routeSearch.z])

  const mapWrapperRef = useRef<HTMLDivElement>(null)
  const viewerHostRef = useRef<HTMLDivElement>(null)
  const markerCanvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null)
  const mapRequestRef = useRef(0)
  const serverGenerationRef = useRef(0)
  const serverProfileRef = useRef(routeSearch.server)
  const layerGenerationRef = useRef(0)
  const layerCoverageRef = useRef(new Map<string, LayerCoverage>())
  const coverageRequestsRef = useRef(new Map<string, Promise<LayerCoverage>>())
  const layerFormatsRef = useRef(new Map<string, string>())
  const formatRequestsRef = useRef(new Map<string, Promise<string>>())
  const tileLoadStatusRef = useRef<TileLoadStatus>({ generation: 0, failures: 0, successes: 0, timer: null })
  const playersGateRef = useRef(createInFlightGate())
  const mountedRef = useRef(false)
  const mapInfoRef = useRef<WorldMapInfo | null>(null)
  const referenceLayerRef = useRef<WorldMapLayer | null>(null)
  const floorRef = useRef(0)
  const playersRef = useRef<MapPlayer[]>([])
  const selectedPlayerRef = useRef<MapPlayer | null>(null)
  const selectedPoiRef = useRef<WorldMapPoi | null>(null)
  const lootResultRef = useRef<LootResult | null>(null)
  const drawRef = useRef<() => void>(() => undefined)
  const drawFrameRef = useRef(0)
  const lastSharedPointRef = useRef('')
  const hasFitMapRef = useRef(false)

  const [mapInfo, setMapInfo] = useState<WorldMapInfo | null>(null)
  const [mapLoading, setMapLoading] = useState(true)
  const [mapError, setMapError] = useState<string | null>(null)
  const [layerLoading, setLayerLoading] = useState(false)
  const [layerError, setLayerError] = useState<string | null>(null)
  const [layerErrorRetryable, setLayerErrorRetryable] = useState(false)
  const [layerMetadataRevision, setLayerMetadataRevision] = useState(0)
  const [tileError, setTileError] = useState(false)
  const [tileRetryNonce, setTileRetryNonce] = useState(0)
  const [poiError, setPoiError] = useState<string | null>(null)
  const [lootTypeError, setLootTypeError] = useState<string | null>(null)
  const [pois, setPois] = useState<WorldMapPoi[]>([])
  const [poiLoading, setPoiLoading] = useState(false)
  const [lootTypes, setLootTypes] = useState<Array<{ id: string; name: string; total: number }>>([])
  const [lootType, setLootType] = useState('')
  const [poiSearch, setPoiSearch] = useState('')
  const [selectedPoi, setSelectedPoi] = useState<WorldMapPoi | null>(null)
  const [lootResult, setLootResult] = useState<LootResult | null>(null)
  const [lootLoading, setLootLoading] = useState(false)
  const [viewerReady, setViewerReady] = useState(false)
  const [renderedGeneration, setRenderedGeneration] = useState(0)
  const renderedFloorRef = useRef<number | null>(null)
  const [mapSize, setMapSize] = useState({ width: 0, height: 0 })
  const [floor, setFloor] = useState(0)
  const [players, setPlayers] = useState<MapPlayer[]>([])
  const [playersLoading, setPlayersLoading] = useState(true)
  const [gameIntegrationConnected, setGameIntegrationConnected] = useState(false)
  const [gameIntegrationLoading, setGameIntegrationLoading] = useState(false)
  const [hasActiveServer, setHasActiveServer] = useState(false)
  const [rosterCollapsed, setRosterCollapsed] = useState(false)
  const [selectedPlayer, setSelectedPlayer] = useState<MapPlayer | null>(null)
  const [hoveredPlayer, setHoveredPlayer] = useState<string | null>(null)
  const [cursorPoint, setCursorPoint] = useState<WorldMapPoint | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  mapInfoRef.current = mapInfo
  referenceLayerRef.current = referenceLayer(mapInfo)
  floorRef.current = floor
  playersRef.current = players
  selectedPlayerRef.current = selectedPlayer
  selectedPoiRef.current = selectedPoi
  lootResultRef.current = lootResult

  const mapFloors = mapFloorRange(mapInfo?.layers ?? [])
  const floorMin = mapFloors.min
  const floorMax = mapFloors.max
  const floorLabelText = floorLabel(floor)

  const requestDraw = useCallback(() => {
    if (drawFrameRef.current) return
    drawFrameRef.current = requestAnimationFrame(() => {
      drawFrameRef.current = 0
      drawRef.current()
    })
  }, [])

  const loadMap = useCallback(async () => {
    const request = ++mapRequestRef.current
    setMapLoading(true)
    setMapError(null)
    setLayerError(null)
    setLayerErrorRetryable(false)
    setLayerLoading(false)
    setTileError(false)
    setPoiLoading(false)
    setMapInfo(null)
    mapInfoRef.current = null
    referenceLayerRef.current = null
    renderedFloorRef.current = null
    setPois([])
    setPoiError(null)
    setLootTypes([])
    setLootType('')
    setLootTypeError(null)
    setSelectedPoi(null)
    setLootResult(null)
    viewerRef.current?.world.removeAll()
    hasFitMapRef.current = false
    try {
      const info = await mapApi.resolve()
      if (!mountedRef.current || request !== mapRequestRef.current) return
      if (!mapMetadataIsValid(info)) throw new Error('The map provider returned invalid map metadata.')
      if (info.layers.length === 0) {
        throw new Error(info.warnings.filter(Boolean).join(' ') || 'No configured map layer is available from the live provider.')
      }
      const { min, max } = mapFloorRange(info.layers)
      const nextFloor = Math.max(min, Math.min(max, floorRef.current))
      floorRef.current = nextFloor
      setFloor(nextFloor)
      setMapInfo(info)
      setMapError(null)
      setPoiLoading(true)
      setPoiError(null)
      setLootTypeError(null)
      void Promise.allSettled([mapApi.pois(info.version), mapApi.lootTypes(info.version)]).then(
        ([poiResult, typeResult]) => {
          if (!mountedRef.current || request !== mapRequestRef.current) return
          if (poiResult.status === 'fulfilled') {
            setPois(poiResult.value.pois)
            setPoiError(null)
          } else {
            setPois([])
            setPoiError(getUserErrorMessage(poiResult.reason, 'POI search is unavailable.'))
          }
          if (typeResult.status === 'fulfilled') {
            setLootTypes(typeResult.value.types)
            setLootType((current) => current || typeResult.value.types[0]?.id || '')
            setLootTypeError(null)
          } else {
            setLootTypes([])
            setLootType('')
            setLootTypeError(getUserErrorMessage(typeResult.reason, 'Container location search is unavailable.'))
          }
          setPoiLoading(false)
        },
      )
    } catch (error) {
      if (!mountedRef.current || request !== mapRequestRef.current) return
      setMapError(getUserErrorMessage(error, 'Live map provider metadata is unavailable.'))
    } finally {
      if (mountedRef.current && request === mapRequestRef.current) setMapLoading(false)
    }
  }, [])

  const refreshActiveServer = useCallback(async () => {
    const generation = serverGenerationRef.current
    try {
      const result = await serversApi.getResolvedActive()
      if (mountedRef.current && generation === serverGenerationRef.current) {
        setHasActiveServer(!!result.server)
      }
    } catch {
      if (mountedRef.current && generation === serverGenerationRef.current) {
        setHasActiveServer(false)
      }
    }
  }, [])

  const fetchPlayerPositions = useCallback(async () => {
    if (!hasActiveServer) {
      setPlayers([])
      setSelectedPlayer(null)
      setGameIntegrationConnected(false)
      setPlayersLoading(false)
      return
    }
    if (!playersGateRef.current.enter()) return
    const generation = serverGenerationRef.current
    try {
      const response = await gameIntegrationApi.getServerInfo()
      if (!mountedRef.current || generation !== serverGenerationRef.current) return
      const rawPlayers = response.success ? response.data?.players ?? [] : null
      if (rawPlayers) {
        setGameIntegrationConnected(true)
        setPlayers((previous) => {
          const previousByName = new Map(previous.map((player) => [player.username, player]))
          const now = performance.now()
          return rawPlayers.flatMap((player) => {
            if (
              typeof player.username !== 'string' ||
              typeof player.x !== 'number' || !Number.isFinite(player.x) ||
              typeof player.y !== 'number' || !Number.isFinite(player.y)
            ) return []
            const old = previousByName.get(player.username)
            return [{
              username: player.username,
              displayName: player.displayName || player.username,
              x: player.x,
              y: player.y,
              z: typeof player.z === 'number' && Number.isFinite(player.z) ? player.z : 0,
              health: player.health?.overallBodyHealth,
              isAlive: player.isAlive,
              isInfected: player.health?.isInfected,
              accessLevel: player.accessLevel,
              hunger: player.stats?.hunger,
              thirst: player.stats?.thirst,
              fatigue: player.stats?.fatigue,
              previousX: old?.x ?? player.x,
              previousY: old?.y ?? player.y,
              movedAt: old && (old.x !== player.x || old.y !== player.y) ? now : now - 500,
            }]
          })
        })
      } else {
        setPlayers([])
        setSelectedPlayer(null)
        setGameIntegrationConnected(false)
      }
    } catch {
      if (mountedRef.current && generation === serverGenerationRef.current) {
        setPlayers([])
        setSelectedPlayer(null)
        setGameIntegrationConnected(false)
      }
    } finally {
      playersGateRef.current.leave()
      if (mountedRef.current && generation === serverGenerationRef.current) {
        setPlayersLoading(false)
      }
    }
  }, [hasActiveServer])

  const refreshGameIntegrationStatus = useCallback(async () => {
    if (!hasActiveServer) {
      setGameIntegrationConnected(false)
      setGameIntegrationLoading(false)
      return
    }
    const generation = serverGenerationRef.current
    setGameIntegrationLoading(true)
    try {
      const result = await gameIntegrationApi.getStatus()
      if (mountedRef.current && generation === serverGenerationRef.current) {
        setGameIntegrationConnected(result.modConnected === true)
      }
    } catch {
      if (mountedRef.current && generation === serverGenerationRef.current) {
        setGameIntegrationConnected(false)
      }
    } finally {
      if (mountedRef.current && generation === serverGenerationRef.current) {
        setGameIntegrationLoading(false)
      }
    }
  }, [hasActiveServer])

  useEffect(() => {
    mountedRef.current = true
    void loadMap()
    void refreshActiveServer()
    return () => {
      mountedRef.current = false
    }
  }, [loadMap, refreshActiveServer])

  const resetForServerChange = useCallback(() => {
    serverGenerationRef.current++
    setHasActiveServer(false)
    setPlayers([])
    setPlayersLoading(true)
    setGameIntegrationConnected(false)
    setSelectedPlayer(null)
    setSelectedPoi(null)
    setPoiSearch('')
    setContextMenu(null)
    setCursorPoint(null)
    setFloor(0)
    floorRef.current = 0
    setMapInfo(null)
    setPois([])
    setPoiError(null)
    setPoiLoading(false)
    setLootTypes([])
    setLootType('')
    setLootTypeError(null)
    setLootResult(null)
    setMapError(null)
    lastSharedPointRef.current = ''
    hasFitMapRef.current = false
    void refreshActiveServer()
    void loadMap()
  }, [loadMap, refreshActiveServer])

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
    void fetchPlayerPositions()
    void refreshGameIntegrationStatus()
  }, [fetchPlayerPositions, refreshGameIntegrationStatus])

  useEffect(() => {
    if (!hasActiveServer) return
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void fetchPlayerPositions()
    }, PLAYER_POLL_MS)
    return () => window.clearInterval(interval)
  }, [fetchPlayerPositions, hasActiveServer])

  useEffect(() => {
    const area = mapWrapperRef.current
    if (!area) return
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0]?.contentRect ?? { width: 0, height: 0 }
      setMapSize({ width: Math.floor(width), height: Math.floor(height) })
      requestDraw()
      viewerRef.current?.forceResize()
    })
    observer.observe(area)
    return () => observer.disconnect()
  }, [requestDraw])

  useEffect(() => {
    const host = viewerHostRef.current
    if (!host) return
    const viewer = OpenSeadragon({
        element: host,
        drawer: 'canvas',
        crossOriginPolicy: false,
        showNavigationControl: false,
        showNavigator: false,
        keyboardNavEnabled: false,
        mouseNavEnabled: true,
        autoResize: true,
        maxZoomPixelRatio: 4,
        animationTime: 0.18,
        gestureSettingsMouse: {
          dragToPan: true,
          scrollToZoom: true,
          clickToZoom: false,
          dblClickToZoom: false,
          zoomToRefPoint: true,
        },
        gestureSettingsTouch: {
          dragToPan: true,
          pinchToZoom: true,
          flickEnabled: true,
          zoomToRefPoint: true,
        },
      })
    viewerRef.current = viewer
    viewer.canvas.tabIndex = 0
    viewer.canvas.setAttribute('role', 'application')
    viewer.canvas.setAttribute('aria-label', 'World map. Use arrow keys to pan and plus or minus to zoom. Right-click for map actions.')
    viewer.canvas.classList.add('outline-none', 'focus-visible:ring-2', 'focus-visible:ring-primary/50')

    const worldAtPixel = (x: number, y: number): WorldMapPoint | null => {
        const reference = referenceLayerRef.current
        if (!reference) return null
        const point = viewer!.viewport.pointFromPixel(new OpenSeadragon.Point(x, y), true)
        return imageToWorld(
          { x: point.x * reference.width, y: point.y * reference.width },
          reference,
          floorRef.current,
        )
    }
    const pixelForWorld = (point: WorldMapPoint): OpenSeadragon.Point | null => {
        const reference = referenceLayerRef.current
        if (!reference) return null
        const image = worldToImage(point, reference)
        return viewer!.viewport.pixelFromPoint(
          new OpenSeadragon.Point(image.x / reference.width, image.y / reference.width),
          true,
        )
    }
    const playerAtPixel = (x: number, y: number): MapPlayer | null => {
        let result: MapPlayer | null = null
        let distance = MIN_MARKER_HIT_RADIUS
        for (const player of playersRef.current) {
          if (Math.round(player.z) !== floorRef.current) continue
          const point = pixelForWorld(interpolatePlayer(player, performance.now()))
          if (!point) continue
          const next = Math.hypot(x - point.x, y - point.y)
          if (next < distance) {
            result = player
            distance = next
          }
        }
        return result
    }

      const pointerMove = (event: PointerEvent) => {
        const rect = viewer!.canvas.getBoundingClientRect()
        const x = event.clientX - rect.left
        const y = event.clientY - rect.top
        setCursorPoint(worldAtPixel(x, y))
        setHoveredPlayer(playerAtPixel(x, y)?.username ?? null)
        requestDraw()
      }
      const pointerLeave = () => {
        setCursorPoint(null)
        setHoveredPlayer(null)
        requestDraw()
    }
    const context = (event: MouseEvent) => {
        if ((event.target as HTMLElement).closest('button, input, select')) return
        event.preventDefault()
        const rect = viewer!.canvas.getBoundingClientRect()
        const pageRect = mapWrapperRef.current?.getBoundingClientRect()
        if (!pageRect) return
        const localX = event.clientX - rect.left
        const localY = event.clientY - rect.top
        const point = worldAtPixel(localX, localY)
        if (!point) return
        setContextMenu({
          x: event.clientX - pageRect.left,
          y: event.clientY - pageRect.top,
          point,
          player: playerAtPixel(localX, localY) ?? undefined,
        })
    }
    const keydown = (event: KeyboardEvent) => {
        if (event.target instanceof HTMLElement && event.target.closest('button, input, select')) return
        const step = viewer!.viewport.deltaPointsFromPixels(new OpenSeadragon.Point(40, 40))
        switch (event.key) {
          case 'ArrowUp':
            event.preventDefault()
            viewer!.viewport.panBy(new OpenSeadragon.Point(0, -step.y), true)
            break
          case 'ArrowDown':
            event.preventDefault()
            viewer!.viewport.panBy(new OpenSeadragon.Point(0, step.y), true)
            break
          case 'ArrowLeft':
            event.preventDefault()
            viewer!.viewport.panBy(new OpenSeadragon.Point(-step.x, 0), true)
            break
          case 'ArrowRight':
            event.preventDefault()
            viewer!.viewport.panBy(new OpenSeadragon.Point(step.x, 0), true)
            break
          case '+':
          case '=':
            event.preventDefault()
            viewer!.viewport.zoomBy(1.4, undefined, true)
            break
          case '-':
            event.preventDefault()
            viewer!.viewport.zoomBy(1 / 1.4, undefined, true)
            break
          case 'Escape':
            setContextMenu(null)
            setSelectedPlayer(null)
            break
        }
    }

    viewer.canvas.addEventListener('pointermove', pointerMove)
    viewer.canvas.addEventListener('pointerleave', pointerLeave)
    viewer.canvas.addEventListener('contextmenu', context)
    viewer.canvas.addEventListener('keydown', keydown)
    viewer.addHandler('canvas-click', (event) => {
      if (!event.quick) return
      setSelectedPlayer(playerAtPixel(event.position.x, event.position.y))
      setContextMenu(null)
    })
    viewer.addHandler('animation', requestDraw)
    viewer.addHandler('viewport-change', requestDraw)
    viewer.addHandler('resize', requestDraw)
    viewer.addHandler('tile-loaded', requestDraw)
    setViewerReady(true)
    requestDraw()

    viewer.addHandler('before-destroy', () => {
      viewer.canvas.removeEventListener('pointermove', pointerMove)
      viewer.canvas.removeEventListener('pointerleave', pointerLeave)
      viewer.canvas.removeEventListener('contextmenu', context)
      viewer.canvas.removeEventListener('keydown', keydown)
    })
    return () => {
      setViewerReady(false)
      if (viewerRef.current === viewer) viewerRef.current = null
      viewer.destroy()
    }
  }, [requestDraw])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewerReady || !viewer || !mapInfo) return
    const reference = referenceLayer(mapInfo)
    if (!reference) return
    referenceLayerRef.current = reference

    const generation = ++layerGenerationRef.current
    const previousStatus = tileLoadStatusRef.current
    if (previousStatus.timer !== null) window.clearTimeout(previousStatus.timer)
    tileLoadStatusRef.current = { generation, failures: 0, successes: 0, timer: null }
    setTileError(false)
    setLayerError(null)
    setLayerErrorRetryable(false)
    setLayerLoading(false)
    renderedFloorRef.current = null
    const hadView = hasFitMapRef.current
    const center = hadView ? viewer.viewport.getCenter(true) : null
    const zoom = hadView ? viewer.viewport.getZoom(true) : null

    const allVisibleLayers = layersForFloor(mapInfo.layers, floor)
    if (allVisibleLayers.length === 0) {
      viewer.world.removeAll()
      setMapError(`No configured map layer contains ${floorLabel(floor)}.`)
      return
    }
    setMapError(null)
    const unsupportedLayers = floor !== 0
      ? allVisibleLayers.filter((layer) => !layer.composite)
      : []
    const visibleLayers = allVisibleLayers.filter((layer) => !unsupportedLayers.includes(layer))
    if (unsupportedLayers.length > 0) {
      setLayerError(`Some configured layers do not provide validated composite tiles for ${floorLabel(floor)} and were skipped.`)
    }
    if (visibleLayers.length === 0) {
      viewer.world.removeAll()
      return
    }

    const cacheKey = (layer: WorldMapLayer) => `${mapInfo.version}\u0000${layer.id}`
    const formatKey = (layer: WorldMapLayer, value: number) => `${cacheKey(layer)}\u0000${value}`
    const ensureCoverage = (layer: WorldMapLayer): Promise<LayerCoverage> => {
      const key = cacheKey(layer)
      const cached = layerCoverageRef.current.get(key)
      if (cached) return Promise.resolve(cached)
      const existing = coverageRequestsRef.current.get(key)
      if (existing) return existing
      const request = mapApi.coverage(mapInfo.version, layer.id).then((coverage) => {
        if (!mapCoverageIsValid(coverage)) throw new Error('The map provider returned invalid floor coverage.')
        const value = { ground: coverage.ground, tiles: indexLayerCoverage(coverage) }
        layerCoverageRef.current.set(key, value)
        return value
      }).finally(() => coverageRequestsRef.current.delete(key))
      coverageRequestsRef.current.set(key, request)
      return request
    }
    const ensureFloorFormat = (layer: WorldMapLayer, requestedFloor: number): Promise<string> => {
      if (requestedFloor === 0) return Promise.resolve(layer.format)
      const key = formatKey(layer, requestedFloor)
      const cached = layerFormatsRef.current.get(key)
      if (cached) return Promise.resolve(cached)
      const existing = formatRequestsRef.current.get(key)
      if (existing) return existing
      const request = mapApi.floor(mapInfo.version, layer.id, requestedFloor).then(({ format }) => {
        if (typeof format !== 'string' || !/^[a-z0-9]+$/i.test(format)) {
          throw new Error('The map provider returned an invalid tile format.')
        }
        layerFormatsRef.current.set(key, format)
        return format
      }).finally(() => formatRequestsRef.current.delete(key))
      formatRequestsRef.current.set(key, request)
      return request
    }

    const pending = new Set<Promise<unknown>>()
    for (const layer of visibleLayers) {
      const key = cacheKey(layer)
      const needsCoverage = layer.composite && floor > 0
      const coverage = needsCoverage ? layerCoverageRef.current.get(key) : undefined
      if (needsCoverage && !coverage) {
        const request = ensureCoverage(layer)
        pending.add(request)
        continue
      }
      const floors = coverage
        ? availableTileFloors(coverage.tiles, coverage.ground, floor)
        : floor === 0 ? [] : [floor]
      for (const requestedFloor of floors) {
        if (requestedFloor === 0) continue
        if (requestedFloor < layer.minFloor || requestedFloor > layer.maxFloor) {
          setLayerError(`The map provider reported unsupported ${floorLabel(requestedFloor)} tile coverage for ${layer.name}.`)
          setLayerErrorRetryable(true)
          return
        }
        const format = layerFormatsRef.current.get(formatKey(layer, requestedFloor))
        if (!format) pending.add(ensureFloorFormat(layer, requestedFloor))
      }
    }
    if (pending.size > 0) {
      setLayerLoading(true)
      void Promise.all(pending).then(() => {
        if (generation === layerGenerationRef.current) setLayerMetadataRevision((value) => value + 1)
      }).catch((error: unknown) => {
        if (generation !== layerGenerationRef.current) return
        viewer.world.removeAll()
        setLayerError(getUserErrorMessage(error, 'Floor map data is unavailable.'))
        setLayerErrorRetryable(true)
      }).finally(() => {
        if (generation === layerGenerationRef.current) setLayerLoading(false)
      })
      return () => {
        const status = tileLoadStatusRef.current
        if (status.generation === generation && status.timer !== null) {
          window.clearTimeout(status.timer)
          status.timer = null
        }
      }
    }

    viewer.world.removeAll()
    let remaining = visibleLayers.length
    const placements = visibleLayers.map((layer) => placeLayer(layer, reference))
    const recordTileLoad = (loaded: boolean) => {
      const status = tileLoadStatusRef.current
      if (status.generation !== generation) return
      if (loaded) {
        status.successes++
        if (status.timer !== null) window.clearTimeout(status.timer)
        status.timer = null
        setTileError(false)
        return
      }
      status.failures++
      if (status.successes > 0 || status.failures < 3 || status.timer !== null) return
      status.timer = window.setTimeout(() => {
        const current = tileLoadStatusRef.current
        if (current.generation === generation && current.successes === 0 && current.failures >= 3) {
          setTileError(true)
        }
        current.timer = null
      }, 1800)
    }

    for (const [index, layer] of visibleLayers.entries()) {
      const maxLevel = Math.ceil(Math.log2(Math.max(layer.width, layer.height)))
      const coverage = layer.composite && floor > 0
        ? layerCoverageRef.current.get(cacheKey(layer))
        : undefined
      const tileFloorAt = (level: number, x: number, y: number) => coverage
        ? tileFloorFor(coverage.tiles, coverage.ground, floor, level, x, y)
        : floor
      const tileFormatAt = (requestedFloor: number) => requestedFloor === 0
        ? layer.format
        : layerFormatsRef.current.get(formatKey(layer, requestedFloor))
      const tileSource = new OpenSeadragon.TileSource({
        ready: true,
        width: layer.width,
        height: layer.height,
        tileSize: layer.tileSize,
        tileOverlap: 0,
        minLevel: 0,
        maxLevel,
      })
      const tileExists = tileSource.tileExists.bind(tileSource)
      tileSource.tileExists = (level, x, y) => {
        if (!tileExists(level, x, y)) return false
        const requestedFloor = tileFloorAt(level, x, y)
        return requestedFloor !== null && !!tileFormatAt(requestedFloor)
      }
      tileSource.getTileUrl = (level, x, y) => {
        const requestedFloor = tileFloorAt(level, x, y) ?? floor
        const format = tileFormatAt(requestedFloor)
        return format ? buildTileUrl(layer, requestedFloor, level, x, y, format) : ''
      }
      tileSource.downloadTileStart = (job) => {
        const image = new window.Image()
        image.referrerPolicy = 'no-referrer'
        job.userData = { image }
        image.onload = () => {
          recordTileLoad(true)
          job.finish(image, null, 'image')
        }
        image.onerror = () => {
          recordTileLoad(false)
          job.fail('Map tile could not be loaded.', null)
        }
        image.src = job.src
      }
      tileSource.downloadTileAbort = (job) => {
        const image = (job.userData as { image?: HTMLImageElement } | null)?.image
        if (!image) return
        image.onload = null
        image.onerror = null
        image.src = ''
      }

      viewer.addTiledImage({
        tileSource,
        x: placements[index].x,
        y: placements[index].y,
        width: placements[index].width,
        height: placements[index].height,
        index,
        success: (event) => {
          if (generation !== layerGenerationRef.current) return
          if (layer.id !== 'base' && layer.cellRects.length > 0) {
            const item = (event as Event & { item?: OpenSeadragon.TiledImage }).item
            const polygons = layerClipPolygons(layer, floor).map((polygon) =>
              polygon.map((point) => new OpenSeadragon.Point(point.x, point.y)),
            )
            item?.setCroppingPolygons(polygons)
          }
          remaining--
          if (remaining !== 0) return
          const left = Math.min(...placements.map((item) => item.x))
          const top = Math.min(...placements.map((item) => item.y))
          const right = Math.max(...placements.map((item) => item.x + item.width))
          const bottom = Math.max(...placements.map((item) => item.y + item.height))
          if (center && zoom !== null) {
            viewer.viewport.panTo(center, true)
            viewer.viewport.zoomTo(zoom, undefined, true)
          } else {
            viewer.viewport.fitBounds(
              new OpenSeadragon.Rect(left, top, right - left, bottom - top),
              true,
            )
            hasFitMapRef.current = true
          }
          renderedFloorRef.current = floor
          setRenderedGeneration((value) => value + 1)
          requestDraw()
        },
      })
    }
    return () => {
      const status = tileLoadStatusRef.current
      if (status.generation === generation && status.timer !== null) {
        window.clearTimeout(status.timer)
        status.timer = null
      }
    }
  }, [mapInfo, floor, viewerReady, layerMetadataRevision, tileRetryNonce, requestDraw])

  const matchingPois = useMemo(() => {
    const query = normalizeMapSearch(poiSearch)
    if (!query) return []
    return pois
      .filter((poi) =>
        normalizeMapSearch(`${poi.name} ${poi.tags.join(' ')}`).includes(query),
      )
      .slice(0, 30)
  }, [poiSearch, pois])

  const setMapFloor = useCallback((value: number) => {
    const mapFloors = mapFloorRange(mapInfoRef.current?.layers ?? [])
    const next = Math.max(mapFloors.min, Math.min(mapFloors.max, value))
    if (next === floorRef.current) return
    floorRef.current = next
    renderedFloorRef.current = null
    setFloor(next)
    setLootResult(null)
    setContextMenu(null)
    setHoveredPlayer(null)
    requestDraw()
  }, [requestDraw])

  const panToPoint = useCallback((point: WorldMapPoint) => {
    const viewer = viewerRef.current
    const reference = referenceLayerRef.current
    if (!viewer || !reference) return
    const mapFloors = mapFloorRange(mapInfoRef.current?.layers ?? [])
    const nextFloor = Math.max(mapFloors.min, Math.min(mapFloors.max, Math.round(point.z)))
    if (nextFloor !== floorRef.current) setMapFloor(nextFloor)
    const image = worldToImage({ ...point, z: nextFloor }, reference)
    const target = new OpenSeadragon.Point(
      image.x / reference.width,
      image.y / reference.width,
    )
    viewer.viewport.zoomTo(
      Math.max(viewer.viewport.getZoom(true), viewer.viewport.getHomeZoom() * 5),
      target,
      true,
    )
    viewer.viewport.panTo(target, true)
    requestDraw()
  }, [requestDraw, setMapFloor])

  useEffect(() => {
    if (!sharedPoint || !mapInfo || !viewerReady || !renderedGeneration) return
    const key = `${sharedPoint.x},${sharedPoint.y},${sharedPoint.z}`
    if (lastSharedPointRef.current === key) return
    const reference = referenceLayer(mapInfo)
    const viewer = viewerRef.current
    if (!reference || !viewer) return
    const mapFloors = mapFloorRange(mapInfo.layers)
    const nextFloor = Math.max(mapFloors.min, Math.min(mapFloors.max, Math.round(sharedPoint.z)))
    if (nextFloor !== floorRef.current) {
      setMapFloor(nextFloor)
      return
    }
    if (renderedFloorRef.current !== nextFloor) return
    const image = worldToImage({ ...sharedPoint, z: nextFloor }, reference)
    const target = new OpenSeadragon.Point(image.x / reference.width, image.y / reference.width)
    viewer.viewport.zoomTo(
      Math.max(viewer.viewport.getZoom(true), viewer.viewport.getHomeZoom() * 5),
      target,
      true,
    )
    viewer.viewport.panTo(target, true)
    lastSharedPointRef.current = key
  }, [sharedPoint, mapInfo, viewerReady, renderedGeneration, floor, setMapFloor])

  useEffect(() => {
    let frame = 0
    const changedPlayers = players.some((player) => performance.now() - player.movedAt < 450)
    if (!changedPlayers) {
      requestDraw()
      return
    }
    const animate = () => {
      requestDraw()
      if (playersRef.current.some((player) => performance.now() - player.movedAt < 450)) {
        frame = requestAnimationFrame(animate)
      }
    }
    frame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame)
  }, [players, selectedPlayer, selectedPoi, lootResult, pois, cursorPoint, hoveredPlayer, floor, theme, requestDraw])

  const drawMapMarkers = useCallback(() => {
    const canvas = markerCanvasRef.current
    const area = mapWrapperRef.current
    const viewer = viewerRef.current
    const reference = referenceLayerRef.current
    if (!canvas || !area) return
    const width = area.clientWidth
    const height = area.clientHeight
    if (!width || !height) return
    const ratio = window.devicePixelRatio || 1
    if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
      canvas.width = Math.floor(width * ratio)
      canvas.height = Math.floor(height * ratio)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const rootStyle = getComputedStyle(document.documentElement)
    const canvasColor = (token: string, alpha = 1) => {
      const value = rootStyle.getPropertyValue(token).trim()
      return value ? `hsl(${value} / ${alpha})` : `rgba(128,128,128,${alpha})`
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)
    if (!viewer || !reference || !mapInfoRef.current || renderedFloorRef.current !== floorRef.current) return

    const toPixel = (point: WorldMapPoint) => {
      const image = worldToImage(point, reference)
      return viewer.viewport.pixelFromPoint(
        new OpenSeadragon.Point(image.x / reference.width, image.y / reference.width),
        true,
      )
    }

    const zoomRatio = viewer.viewport.getZoom(true) / viewer.viewport.getHomeZoom()
    if (zoomRatio > 2) {
      for (const poi of pois) {
        if (Math.round(poi.z) !== floorRef.current) continue
        const point = toPixel(poi)
        if (point.x < -8 || point.x > width + 8 || point.y < -8 || point.y > height + 8) continue
        ctx.beginPath()
        ctx.arc(point.x, point.y, 2.5, 0, Math.PI * 2)
        ctx.fillStyle = canvasColor('--accent', 0.75)
        ctx.fill()
      }
    }

    const now = performance.now()
    for (const player of playersRef.current) {
      if (Math.round(player.z) !== floorRef.current) continue
      const point = toPixel(interpolatePlayer(player, now))
      if (point.x < -48 || point.x > width + 48 || point.y < -48 || point.y > height + 48) continue
      const selected = selectedPlayerRef.current?.username === player.username
      const hovered = hoveredPlayer === player.username
      const radius = hovered || selected ? 9 : 7
      ctx.beginPath()
      ctx.arc(point.x, point.y, radius + 2, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0,0,0,0.72)'
      ctx.fill()
      ctx.beginPath()
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
      ctx.fillStyle = canvasColor(playerColorToken(player), 0.96)
      ctx.fill()
      if (player.isInfected && player.isAlive !== false) {
        ctx.beginPath()
        ctx.setLineDash([2, 2])
        ctx.arc(point.x, point.y, radius + 4, 0, Math.PI * 2)
        ctx.strokeStyle = canvasColor('--destructive', 0.9)
        ctx.stroke()
        ctx.setLineDash([])
      }
      if (player.isAlive === false) {
        ctx.strokeStyle = canvasColor('--foreground', 0.9)
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(point.x - 3, point.y - 3)
        ctx.lineTo(point.x + 3, point.y + 3)
        ctx.moveTo(point.x + 3, point.y - 3)
        ctx.lineTo(point.x - 3, point.y + 3)
        ctx.stroke()
      }
      if (selected || hovered || zoomRatio > 4) {
        const label = player.displayName || player.username
        ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.lineWidth = 3
        ctx.strokeStyle = 'rgba(0,0,0,0.8)'
        ctx.strokeText(label, point.x, point.y - radius - 5)
        ctx.fillStyle = canvasColor('--foreground')
        ctx.fillText(label, point.x, point.y - radius - 5)
      }
      if (player.health !== undefined && zoomRatio > 2 && player.isAlive !== false) {
        const barWidth = 24
        const x = point.x - barWidth / 2
        const y = point.y + radius + 5
        const health = Math.max(0, Math.min(100, player.health)) / 100
        ctx.fillStyle = 'rgba(0,0,0,0.7)'
        ctx.fillRect(x, y, barWidth, 3)
        ctx.fillStyle = health > 0.5
          ? canvasColor('--success')
          : health > 0.25
            ? canvasColor('--warning')
            : canvasColor('--destructive')
        ctx.fillRect(x, y, barWidth * health, 3)
      }
    }

    const poi = selectedPoiRef.current
    if (poi && Math.round(poi.z) === floorRef.current) {
      const point = toPixel(poi)
      ctx.beginPath()
      ctx.arc(point.x, point.y, 11, 0, Math.PI * 2)
      ctx.strokeStyle = canvasColor('--accent', 0.95)
      ctx.lineWidth = 2
      ctx.stroke()
    }
    const search = lootResultRef.current
    if (search) {
      for (const location of search.locations) {
        if (Math.round(location.z) !== floorRef.current) continue
        const point = toPixel(location)
        ctx.beginPath()
        ctx.arc(point.x, point.y, 5, 0, Math.PI * 2)
        ctx.fillStyle = canvasColor('--warning', 0.88)
        ctx.strokeStyle = 'rgba(0,0,0,0.75)'
        ctx.lineWidth = 2
        ctx.fill()
        ctx.stroke()
      }
    }
    if (cursorPoint) {
      const point = toPixel(cursorPoint)
      ctx.strokeStyle = canvasColor('--foreground', 0.45)
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(point.x - 9, point.y)
      ctx.lineTo(point.x + 9, point.y)
      ctx.moveTo(point.x, point.y - 9)
      ctx.lineTo(point.x, point.y + 9)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }, [cursorPoint, hoveredPlayer, pois])

  drawRef.current = drawMapMarkers

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null)
        setSelectedPlayer(null)
      }
    }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [])

  useEffect(() => {
    if (!contextMenu) return
    const onClick = (event: MouseEvent) => {
      const menu = mapWrapperRef.current?.querySelector('[role="menu"]')
      if (menu && !menu.contains(event.target as Node)) setContextMenu(null)
    }
    document.addEventListener('mousedown', onClick, true)
    return () => document.removeEventListener('mousedown', onClick, true)
  }, [contextMenu])

  const zoomIn = useCallback(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.viewport.zoomBy(1.4)
    viewer.viewport.applyConstraints()
  }, [])

  const zoomOut = useCallback(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.viewport.zoomBy(1 / 1.4)
    viewer.viewport.applyConstraints()
  }, [])

  const fitToPlayers = useCallback(() => {
    const viewer = viewerRef.current
    const reference = referenceLayerRef.current
    const online = playersRef.current.filter((player) => Math.round(player.z) === floorRef.current)
    if (!viewer || !reference || online.length === 0) {
      viewer?.viewport.goHome()
      return
    }
    const points = online.map((player) => {
      const image = worldToImage(player, reference)
      return { x: image.x / reference.width, y: image.y / reference.width }
    })
    const minX = Math.min(...points.map((point) => point.x))
    const maxX = Math.max(...points.map((point) => point.x))
    const minY = Math.min(...points.map((point) => point.y))
    const maxY = Math.max(...points.map((point) => point.y))
    const padding = Math.max(maxX - minX, maxY - minY, viewer.viewport.getHomeZoom() * 0.15) * 0.6
    viewer.viewport.fitBounds(
      new OpenSeadragon.Rect(minX - padding, minY - padding, maxX - minX + padding * 2, maxY - minY + padding * 2),
      true,
    )
  }, [])

  const panToPlayer = useCallback((player: MapPlayer) => {
    setSelectedPlayer(player)
    panToPoint(player)
  }, [panToPoint])

  const setPoi = useCallback((poi: WorldMapPoi) => {
    setSelectedPoi(poi)
    setPoiSearch(poi.name)
    setContextMenu(null)
    panToPoint(poi)
  }, [panToPoint])

  const copyCoordinates = useCallback(async (point: WorldMapPoint) => {
    const text = `${Math.round(point.x)}, ${Math.round(point.y)}, ${Math.round(point.z)}`
    const ok = await copyText(text)
    toast(ok
      ? { title: 'Copied coordinates', description: text }
      : { title: 'Copy failed', description: 'Clipboard unavailable', variant: 'destructive' })
  }, [toast])

  const copyShareLink = useCallback(async () => {
    const viewer = viewerRef.current
    const reference = referenceLayerRef.current
    if (!viewer || !reference) return
    let point = cursorPoint ?? (selectedPlayer ? { ...selectedPlayer, z: floorRef.current } : null)
    if (!point) {
      const center = viewer.viewport.getCenter(true)
      point = imageToWorld(
        { x: center.x * reference.width, y: center.y * reference.width },
        reference,
        floorRef.current,
      )
    }
    const url = new URL(window.location.href)
    url.searchParams.set('x', String(Math.round(point.x)))
    url.searchParams.set('y', String(Math.round(point.y)))
    url.searchParams.set('z', String(Math.round(floorRef.current)))
    const ok = await copyText(url.toString())
    toast(ok
      ? { title: 'Map link copied', description: `${Math.round(point.x)}, ${Math.round(point.y)}, ${Math.round(floorRef.current)}` }
      : { title: 'Copy failed', description: 'Clipboard unavailable', variant: 'destructive' })
  }, [cursorPoint, selectedPlayer, toast])

  const teleportPlayerTo = useCallback(async (player: string, point: WorldMapPoint) => {
    const coordinates = {
      x: Math.round(point.x),
      y: Math.round(point.y),
      z: Math.round(point.z),
    }
    const accepted = await confirm({
      title: `Teleport ${player}?`,
      description: `Move ${player} to ${coordinates.x}, ${coordinates.y}, floor ${coordinates.z}.`,
      confirmLabel: 'Teleport player',
      variant: 'warning',
    })
    if (!accepted) return
    setActionLoading(player)
    try {
      await playersApi.teleport(player, coordinates)
      toast({ title: 'Player teleported', description: `${player} → ${coordinates.x}, ${coordinates.y}, ${coordinates.z}` })
      void fetchPlayerPositions()
    } catch (error) {
      toast({ title: 'Teleport error', description: getUserErrorMessage(error, 'Could not teleport player.'), variant: 'destructive' })
    } finally {
      setActionLoading(null)
    }
  }, [confirm, fetchPlayerPositions, toast])

  const searchLootNear = useCallback(async (point: WorldMapPoint) => {
    if (!mapInfo || !lootType) return
    setLootLoading(true)
    setContextMenu(null)
    try {
      const result = await mapApi.loot(mapInfo.version, lootType, point)
      const next = { point, type: lootType, locations: result.points, truncated: result.truncated }
      setLootResult(next)
      toast({
        title: 'Container locations found',
        description: `${result.points.length} nearby ${lootTypes.find((type) => type.id === lootType)?.name ?? 'container'} locations.`,
      })
    } catch (error) {
      toast({ title: 'Location search failed', description: getUserErrorMessage(error, 'Could not search nearby container locations.'), variant: 'destructive' })
    } finally {
      setLootLoading(false)
    }
  }, [mapInfo, lootType, lootTypes, toast])

  const handleRefresh = useCallback(() => {
    void loadMap()
    void fetchPlayerPositions()
    void refreshGameIntegrationStatus()
  }, [loadMap, fetchPlayerPositions, refreshGameIntegrationStatus])

  return (
    <div className="space-y-4 page-transition">
      <PageHeader
        title="World Map"
        description="Live player positions and configured map layers. Right-click for actions."
        icon={<MapIcon className="h-5 w-5" />}
        tone="world"
        actions={
          <div className="flex items-center gap-2">
            <GameIntegrationStatusBadge connected={gameIntegrationConnected} loading={gameIntegrationLoading} />
            <Button variant="outline" size="sm" onClick={handleRefresh} className="gap-2" disabled={mapLoading}>
              {mapLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>
        }
      />

      <div
        ref={mapWrapperRef}
        className="relative overflow-hidden rounded-md border border-border/60 bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.35)]"
      >
        <span aria-hidden className="pointer-events-none absolute start-0 top-0 z-30 h-3 w-3 border-s-2 border-t-2 border-primary/50" />
        <span aria-hidden className="pointer-events-none absolute end-0 top-0 z-30 h-3 w-3 border-e-2 border-t-2 border-primary/50" />
        <span aria-hidden className="pointer-events-none absolute bottom-0 start-0 z-30 h-3 w-3 border-s-2 border-b-2 border-primary/50" />
        <span aria-hidden className="pointer-events-none absolute bottom-0 end-0 z-30 h-3 w-3 border-e-2 border-b-2 border-primary/50" />

        <div className="relative w-full" style={{ height: 'calc(100vh - 180px)', minHeight: '500px' }}>
          <div ref={viewerHostRef} className="absolute inset-0 bg-background" />
          <canvas ref={markerCanvasRef} aria-hidden className="pointer-events-none absolute inset-0 z-[1] h-full w-full" />

          <div className="absolute start-3 top-3 z-10 w-14 overflow-hidden rounded-md border border-border/55 bg-card/85 shadow-lg backdrop-blur-md">
            <div className="flex items-center justify-center border-b border-border/40 bg-muted/40 px-1 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-primary/70">
              <span><span className="text-primary/60">//</span> ctrl</span>
            </div>
            <div className="flex flex-col items-center gap-1 p-1">
              <button type="button" onClick={zoomIn} aria-label="Zoom in" title="Zoom in" className="flex h-11 w-11 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60">
                <ZoomIn className="h-4 w-4" />
              </button>
              <button type="button" onClick={zoomOut} aria-label="Zoom out" title="Zoom out" className="flex h-11 w-11 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60">
                <ZoomOut className="h-4 w-4" />
              </button>
              <button type="button" onClick={fitToPlayers} aria-label="Fit map to online players" title="Fit to players" className="flex h-11 w-11 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60">
                <Maximize2 className="h-4 w-4" />
              </button>
            </div>
            <div className="border-y border-border/40 bg-muted/30 px-1 py-1 text-center font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70">floor</div>
            <div className="flex flex-col items-center gap-1 p-1">
              <button type="button" onClick={() => setMapFloor(floor + 1)} disabled={!mapInfo || floor >= floorMax} aria-label="Floor up" className="flex h-11 w-11 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-30">
                <ChevronUp className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => setMapFloor(0)} aria-label={`Current floor: ${floorLabelText}; click to reset to ground`} title={`${floorLabelText} — click to reset to ground`} className={cn('flex h-11 w-11 items-center justify-center rounded-sm border font-mono text-[10px] font-semibold tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60', floor !== 0 ? 'border-accent/40 bg-accent/20 text-accent' : 'border-border/40 bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground')}>
                {floor === 0 ? <Layers className="h-4 w-4" /> : floor > 0 ? `+${floor}` : floor}
              </button>
              <button type="button" onClick={() => setMapFloor(floor - 1)} disabled={!mapInfo || floor <= floorMin} aria-label="Floor down" className="flex h-11 w-11 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-30">
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="absolute start-[4.75rem] top-3 z-10 flex max-w-[calc(100%-5.5rem)] flex-wrap items-start gap-2">
            <div className="relative w-[min(17rem,calc(100vw-8rem))] rounded-md border border-border/55 bg-card/90 shadow-lg backdrop-blur-md">
              <label className="flex h-11 items-center gap-2 px-3">
                {poiLoading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : <Search className="h-4 w-4 shrink-0 text-muted-foreground" />}
                <Input
                  type="search"
                  value={poiSearch}
                  onChange={(event) => setPoiSearch(event.target.value)}
                  placeholder="Search places or tags"
                  aria-label="Search points of interest by name or tag"
                  className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                />
                {poiSearch && <button type="button" onClick={() => { setPoiSearch(''); setSelectedPoi(null) }} aria-label="Clear place search" className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground"><X className="h-4 w-4" /></button>}
              </label>
              {poiSearch && (
                <div className="absolute start-0 top-full mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-border/60 bg-card/95 p-1 shadow-xl backdrop-blur-md">
                  {poiError ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">{poiError}</p>
                  ) : matchingPois.length > 0 ? matchingPois.map((poi) => (
                    <button key={poi.id} type="button" onClick={() => setPoi(poi)} className="flex min-h-11 w-full items-start gap-2 rounded px-2.5 py-2 text-start text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60">
                      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-foreground">{poi.name}</span>
                        {poi.tags.length > 0 && <span className="block truncate text-[10px] text-muted-foreground">{poi.tags.join(' · ')}</span>}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">{Math.round(poi.x)}, {Math.round(poi.y)}</span>
                    </button>
                  )) : poiLoading ? (
                    <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading places…</p>
                  ) : <p className="px-3 py-2 text-xs text-muted-foreground">No matching places or tags.</p>}
                </div>
              )}
            </div>
            <div className="max-w-[min(15rem,calc(100vw-8rem))] rounded-md border border-border/55 bg-card/90 p-2 shadow-lg backdrop-blur-md">
              <label className="flex min-h-8 items-center gap-2">
                <PackageSearch className="h-4 w-4 shrink-0 text-warning" />
                <select value={lootType} onChange={(event) => { setLootType(event.target.value); setLootResult(null) }} aria-label="Container type to find near a map point" className="min-h-8 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary/60" disabled={lootTypes.length === 0}>
                  {lootTypes.length === 0 ? <option value="">Container locations unavailable</option> : lootTypes.map((type) => <option key={type.id} value={type.id}>{type.name} ({type.total})</option>)}
                </select>
              </label>
              <p className="max-w-56 text-[10px] leading-snug text-muted-foreground">Right-click a point to search nearby container locations. This is map location data, not live inventory.</p>
              {lootTypeError && <p className="mt-1 text-[10px] text-warning">{lootTypeError}</p>}
            </div>
          </div>

          <div className="absolute end-3 top-3 z-10 max-w-[min(14rem,calc(100%-3rem))]">
            <div className="overflow-hidden rounded-md border border-border/55 bg-card/85 shadow-lg backdrop-blur-md">
              <button type="button" onClick={() => setRosterCollapsed((value) => !value)} aria-expanded={!rosterCollapsed} aria-label={rosterCollapsed ? 'Expand player roster' : 'Collapse player roster'} className="flex min-h-11 w-full items-center justify-between gap-2 border-b border-border/40 bg-muted/40 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-primary/70 hover:bg-muted/60">
                <span className="flex min-w-0 items-center gap-1.5"><span className="text-primary/60">//</span><span>roster</span><span className="text-muted-foreground/50">·</span><span className={cn('flex items-center gap-1', gameIntegrationConnected ? 'text-emerald-400/90' : 'text-muted-foreground/60')}><span className={cn('h-1.5 w-1.5 rounded-full', gameIntegrationConnected ? 'bg-emerald-400 animate-pulse' : 'bg-muted-foreground/40')} />{gameIntegrationConnected ? 'live' : 'offline'}</span></span>
                <span className="flex shrink-0 items-center gap-1.5"><span className="font-semibold tabular-nums text-foreground">{players.length}</span>{rosterCollapsed ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}</span>
              </button>
              {!rosterCollapsed && (players.length > 0 ? (
                <div className="max-h-60 overflow-y-auto">
                  {players.map((player) => (
                    <button key={player.username} type="button" onClick={() => panToPlayer(player)} aria-label={`Pan to ${player.displayName || player.username}${player.health === undefined ? '' : `, health ${Math.round(player.health)}%`}`} className={cn('flex min-h-11 w-full items-center gap-2 border-s-2 border-transparent px-2.5 py-1.5 text-start text-xs transition-colors hover:bg-muted/50', selectedPlayer?.username === player.username && 'border-primary/60 bg-muted/50')}>
                      <span className="h-2 w-2 shrink-0 rounded-full ring-1 ring-black/30" style={{ backgroundColor: getPlayerColor(player, 0.9) }} />
                      <span className="flex-1 truncate">{player.displayName || player.username}</span>
                      {player.health !== undefined && <span className={cn('font-mono text-[10px] tabular-nums', player.health > 50 ? 'text-emerald-400' : player.health > 25 ? 'text-amber-400' : 'text-destructive')}>{Math.round(player.health)}%</span>}
                    </button>
                  ))}
                </div>
              ) : <div className="flex items-center gap-2 px-3 py-3 font-mono text-[11px] text-muted-foreground/70"><span className={cn('h-1.5 w-1.5 rounded-full', gameIntegrationConnected ? 'bg-muted-foreground/40' : 'bg-destructive/70')} />{playersLoading ? 'loading…' : gameIntegrationConnected ? 'no players online' : 'game integration offline'}</div>)}
            </div>
          </div>

          {(mapLoading || layerLoading || mapError || layerError) && (
            <div className={cn('absolute start-1/2 top-1/2 z-10 w-[min(28rem,calc(100%-8rem))] -translate-x-1/2 -translate-y-1/2 rounded-md border bg-card/95 p-4 text-center shadow-xl backdrop-blur-md', mapError || layerError ? 'border-warning/60' : 'border-border/50')} role={mapError || layerError ? 'alert' : 'status'} aria-live="polite">
              {mapError || layerError ? <>
                <div className="mb-1 flex items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-warning"><AlertTriangle className="h-4 w-4" />{mapError ? 'Live map unavailable' : 'Floor imagery unavailable'}</div>
                <p className="text-sm text-foreground">{mapError ?? layerError}</p>
                <p className="mt-1 text-xs text-muted-foreground">Player status and the rest of the panel are still available.</p>
                {(mapError || layerErrorRetryable) && <Button size="sm" variant="outline" onClick={() => mapError ? void loadMap() : setTileRetryNonce((value) => value + 1)} disabled={mapLoading || layerLoading} className="mt-3 gap-2">
                  {mapLoading || layerLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {mapError ? 'Retry map' : 'Retry floor data'}
                </Button>}
              </> : <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{mapLoading ? 'Loading live map metadata…' : 'Loading floor map data…'}</div>}
            </div>
          )}

          {tileError && !mapError && !layerError && <div className="absolute start-1/2 bottom-16 z-10 flex -translate-x-1/2 items-center gap-3 rounded-md border border-warning/50 bg-card/95 px-3 py-2 text-xs text-foreground shadow-lg backdrop-blur-md" role="alert" aria-live="polite">
            <span>Map images failed to load from PZMap.</span>
            <Button size="sm" variant="outline" onClick={() => { setTileError(false); setTileRetryNonce((value) => value + 1) }} className="h-8 shrink-0 gap-1.5"><RefreshCw className="h-3.5 w-3.5" />Retry tiles</Button>
          </div>}

          {mapInfo && (
            <div className="absolute bottom-3 end-3 z-10 max-w-[min(24rem,calc(100%-6rem))] space-y-1 text-end">
              <div className="rounded-md border border-border/55 bg-card/85 px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground shadow-lg backdrop-blur-md">
                <span className="text-foreground">{mapInfo.label}</span><span className="mx-1.5 text-border">·</span>{mapInfo.layers.length} configured layer{mapInfo.layers.length === 1 ? '' : 's'}<span className="mx-1.5 text-border">·</span><a href="https://pzmap.org/" target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-2 hover:text-foreground">PZMap</a><HelpTip label="Map image privacy" className="ms-1 align-middle"><span>Map images load directly from PZMap. The provider receives your IP address and viewed map version, floor, zoom and tile coordinates; the panel URL is withheld.</span></HelpTip>
              </div>
              {mapInfo.warnings.length > 0 && <div className="rounded-md border border-warning/35 bg-card/90 px-2.5 py-1.5 text-start text-[10px] text-warning shadow-lg" role="note">{mapInfo.warnings.join(' ')}</div>}
              {lootResult && <div className="rounded-md border border-warning/40 bg-card/90 px-2.5 py-1.5 text-start text-[10px] text-foreground shadow-lg backdrop-blur-md" role="status">
                <div className="flex items-center justify-between gap-3"><span>{lootResult.locations.length} nearby container locations</span><button type="button" aria-label="Clear container locations" onClick={() => setLootResult(null)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground"><X className="h-3.5 w-3.5" /></button></div>
                <p className="text-muted-foreground">Nearby map cells · location data, not inventory.</p>
                {lootResult.truncated && <p className="text-warning">More than 100 found; showing the first 100 nearby locations.</p>}
              </div>}
            </div>
          )}

          <div className="absolute bottom-3 start-3 z-10 flex max-w-[calc(100%-3rem)] flex-wrap items-stretch overflow-hidden rounded-md border border-border/55 bg-card/85 font-mono text-[11px] tabular-nums shadow-lg backdrop-blur-md">
            <div className="flex min-h-11 items-center gap-1.5 border-e border-border/40 px-2.5 py-1.5">
              <Crosshair className={cn('h-3 w-3', cursorPoint ? 'text-primary/80' : 'text-muted-foreground/40')} />
              {cursorPoint ? <span className="text-foreground"><span className="text-muted-foreground/60">x</span>{Math.round(cursorPoint.x)}<span className="mx-1 text-muted-foreground/40">·</span><span className="text-muted-foreground/60">y</span>{Math.round(cursorPoint.y)}</span> : <span className="text-muted-foreground/50">hover for coords</span>}
            </div>
            <div className="flex min-h-11 items-center gap-1 border-e border-border/40 px-2.5 py-1.5"><span className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground/50">z</span><span className={floor !== 0 ? 'text-accent' : 'text-muted-foreground/70'}>{floorLabelText}</span></div>
            <button type="button" onClick={copyShareLink} disabled={!mapInfo} aria-label="Copy map link with coordinates" className="flex min-h-11 items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-40"><Copy className="h-3 w-3" /><span>share</span></button>
          </div>

          {selectedPlayer && (
            <div className="absolute bottom-16 end-3 z-10 w-[min(15rem,calc(100%-1.5rem))] sm:bottom-3">
              <div className="relative overflow-hidden rounded-md border border-border/55 bg-card/90 shadow-lg backdrop-blur-md">
                <span aria-hidden className="pointer-events-none absolute start-0 top-0 h-2 w-2 border-s-2 border-t-2 border-primary/50" />
                <span aria-hidden className="pointer-events-none absolute end-0 top-0 h-2 w-2 border-e-2 border-t-2 border-primary/50" />
                <div className="flex items-center justify-between gap-2 border-b border-border/40 bg-muted/40 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-primary/70">
                  <span className="flex items-center gap-1.5"><span className="text-primary/60">//</span>dossier<span className="text-muted-foreground/50">·</span><span className="text-emerald-400/90">target.acquired</span></span>
                  <button type="button" onClick={() => setSelectedPlayer(null)} aria-label="Close player details" className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
                </div>
                <div className="flex items-center gap-2 border-b border-border/30 px-3 py-2"><span className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/30" style={{ backgroundColor: getPlayerColor(selectedPlayer, 0.9) }} /><span className="truncate text-sm font-semibold">{selectedPlayer.displayName || selectedPlayer.username}</span></div>
                <div className="space-y-1.5 px-3 py-2 text-xs">
                  <PlayerValue label="pos" value={`${Math.round(selectedPlayer.x)}, ${Math.round(selectedPlayer.y)}`} />
                  <PlayerValue label="floor" value={String(selectedPlayer.z)} />
                  {selectedPlayer.health !== undefined && <PlayerBar label="hp" value={selectedPlayer.health} percent />}
                  {selectedPlayer.hunger !== undefined && <PlayerBar label="hunger" value={selectedPlayer.hunger * 100} percent />}
                  {selectedPlayer.thirst !== undefined && <PlayerBar label="thirst" value={selectedPlayer.thirst * 100} percent />}
                  {selectedPlayer.fatigue !== undefined && <PlayerBar label="fatigue" value={selectedPlayer.fatigue * 100} percent />}
                  {selectedPlayer.accessLevel && !['none', 'user'].includes(selectedPlayer.accessLevel) && <PlayerValue label="role" value={selectedPlayer.accessLevel} tone="text-amber-400" />}
                  {selectedPlayer.isInfected && <PlayerValue label="status" value="infected" tone="text-destructive" />}
                </div>
                <div className="space-y-1 border-t border-border/40 bg-muted/20 px-2 py-1.5">
                  <div className="grid grid-cols-2 gap-1">
                    <Button size="sm" variant="ghost" className="h-9 gap-1 text-xs" disabled={actionLoading !== null} onClick={() => {
                      setActionLoading('heal-card')
                      void gameIntegrationApi.healPlayer(selectedPlayer.username).then((result) => {
                        if (!result.success) throw new Error(result.error || 'Heal failed.')
                        toast({ title: 'Healed', description: `${selectedPlayer.username} healed` })
                        void fetchPlayerPositions()
                      }).catch((error) => toast({ title: 'Heal failed', description: getUserErrorMessage(error, 'Could not heal player.'), variant: 'destructive' })).finally(() => setActionLoading(null))
                    }}><Heart className="h-3.5 w-3.5" />Heal</Button>
                    <div className="flex min-w-0 items-center gap-1"><Button size="sm" variant="ghost" className="h-9 w-full gap-1 text-xs" disabled={actionLoading !== null} onClick={() => {
                      setActionLoading('god-card')
                      void playersApi.setGodMode(selectedPlayer.username, true).then(() => toast({ title: 'God mode enabled' })).catch((error) => toast({ title: 'God mode failed', description: getUserErrorMessage(error, 'Could not enable god mode.'), variant: 'destructive' })).finally(() => setActionLoading(null))
                    }}><Shield className="h-3.5 w-3.5" />God</Button><HelpTip label="God"><span>Always turns God Mode on for this player. Turn it back off from Players.</span></HelpTip></div>
                  </div>
                  <Link to="/players" search={{ player: selectedPlayer.username }} onClick={() => setSelectedPlayer(null)} className="flex min-h-9 items-center justify-center gap-1.5 rounded-sm border border-border/50 px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"><Users className="h-3.5 w-3.5" /><span>Open player controls</span><ArrowUpRight className="h-3.5 w-3.5" /></Link>
                </div>
              </div>
            </div>
          )}

          {contextMenu && (
            <div
              ref={(element) => element?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus()}
              role="menu"
              aria-label="Map actions"
              className="absolute z-20 max-h-[calc(100%-1.5rem)] min-w-[220px] overflow-y-auto overscroll-contain rounded-md border border-border/55 bg-card/95 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.6)] ring-1 ring-primary/10 backdrop-blur-md sm:min-w-[260px]"
              style={{
                left: contextMenu.x,
                top: contextMenu.y,
                transform: `${contextMenu.x > mapSize.width / 2 ? 'translateX(-100%)' : ''} ${contextMenu.y > mapSize.height / 2 ? 'translateY(-100%)' : ''}`.trim() || undefined,
              }}
              onKeyDown={(event) => {
                const items = event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
                const index = Array.from(items).indexOf(document.activeElement as HTMLButtonElement)
                if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length]?.focus() }
                else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus() }
                else if (event.key === 'Escape') { event.preventDefault(); setContextMenu(null) }
              }}
            >
              <div className="flex items-center justify-between gap-2 border-b border-border/40 bg-muted/30 px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-primary/70">
                <span className="min-w-0 truncate"><span className="text-primary/60">//</span> actions <span className="text-foreground">· {Math.round(contextMenu.point.x)}, {Math.round(contextMenu.point.y)} · {floorLabel(Math.round(contextMenu.point.z))}</span></span>
                <button type="button" title="Copy coordinates" aria-label="Copy coordinates" className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground" onClick={() => void copyCoordinates(contextMenu.point)}><Copy className="h-3.5 w-3.5" /></button>
              </div>
              {contextMenu.player && <>
                <ContextMenuSection label="target" icon={<Users className="h-3 w-3" />} />
                <ContextMenuItem icon={<Heart className="h-4 w-4 text-emerald-400" />} label="Heal player" onClick={() => {
                  const player = contextMenu.player!
                  void gameIntegrationApi.healPlayer(player.username).then((result) => {
                    if (!result.success) throw new Error(result.error || 'Heal failed.')
                    toast({ title: 'Healed', description: `${player.username} healed` })
                    void fetchPlayerPositions()
                  }).catch((error) => toast({ title: 'Heal failed', description: getUserErrorMessage(error, 'Could not heal player.'), variant: 'destructive' }))
                  setContextMenu(null)
                }} />
              </>}
              {lootType && <>
                <ContextMenuSection label="container locations" icon={<PackageSearch className="h-3 w-3" />} tone="warning" />
                <ContextMenuItem icon={lootLoading ? <Loader2 className="h-4 w-4 animate-spin text-warning" /> : <MapPin className="h-4 w-4 text-warning" />} label={`Search nearby ${lootTypes.find((type) => type.id === lootType)?.name ?? 'containers'}`} description="Nearby cells · map locations, not inventory" disabled={lootLoading} onClick={() => void searchLootNear(contextMenu.point)} />
              </>}
              {players.length > 0 && <>
                <ContextMenuSection label="teleport to coordinates" icon={<Locate className="h-3 w-3" />} tone="primary" />
                {players.slice(0, 6).map((player) => <ContextMenuItem key={player.username} icon={<Users className={cn('h-4 w-4', player.isInfected ? 'text-destructive' : player.accessLevel && !['none', 'user'].includes(player.accessLevel) ? 'text-amber-400' : 'text-info')} />} label={player.displayName || player.username} description={`${Math.round(player.x)}, ${Math.round(player.y)} → ${Math.round(contextMenu.point.x)}, ${Math.round(contextMenu.point.y)}, ${Math.round(contextMenu.point.z)}`} loading={actionLoading === player.username} disabled={!gameIntegrationConnected || actionLoading !== null} onClick={() => void teleportPlayerTo(player.username, contextMenu.point)} />)}
                {players.length > 6 && <div className="px-3 py-2 font-mono text-[10px] italic text-muted-foreground/50">+{players.length - 6} more online</div>}
              </>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PlayerValue({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return <div className="flex items-baseline justify-between gap-3"><span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70">{label}</span><span className={cn('truncate font-mono tabular-nums', tone)}>{value}</span></div>
}

function PlayerBar({ label, value, percent = false }: { label: string; value: number; percent?: boolean }) {
  const amount = Math.max(0, Math.min(100, value))
  const color = label === 'hp'
    ? amount > 50 ? 'hsl(var(--success))' : amount > 25 ? 'hsl(var(--warning))' : 'hsl(var(--destructive))'
    : amount < 50 ? 'hsl(var(--success))' : amount < 75 ? 'hsl(var(--warning))' : 'hsl(var(--destructive))'
  return <div className="flex items-center justify-between gap-3"><span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70">{label}</span><div className="flex items-center gap-1.5"><div className="h-1.5 w-16 overflow-hidden rounded-sm bg-muted/60 ring-1 ring-black/20"><div className="h-full" style={{ width: `${amount}%`, backgroundColor: color }} /></div><span className="w-8 text-end font-mono tabular-nums">{Math.round(amount)}{percent ? '%' : ''}</span></div></div>
}

type ContextMenuTone = 'default' | 'primary' | 'warning' | 'danger' | 'info' | 'success'

function ContextMenuItem({ icon, label, onClick, loading, description, disabled, tone = 'default' }: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  loading?: boolean
  description?: string
  disabled?: boolean
  tone?: ContextMenuTone
}) {
  const toneAccent: Record<ContextMenuTone, string> = {
    default: 'group-hover:border-s-primary/60 group-focus-visible:border-s-primary/60',
    primary: 'group-hover:border-s-primary/70 group-focus-visible:border-s-primary/70',
    warning: 'group-hover:border-s-amber-400/80 group-focus-visible:border-s-amber-400/80',
    danger: 'group-hover:border-s-destructive/80 group-focus-visible:border-s-destructive/80',
    info: 'group-hover:border-s-info/80 group-focus-visible:border-s-info/80',
    success: 'group-hover:border-s-emerald-400/80 group-focus-visible:border-s-emerald-400/80',
  }
  return <button role="menuitem" type="button" onClick={onClick} disabled={loading || disabled} className="group relative flex min-h-11 w-full items-stretch gap-2.5 pe-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 hover:bg-muted/45 focus-visible:bg-muted/45 focus-visible:outline-none"><span aria-hidden className={cn('my-1 w-[2px] shrink-0 border-s-2 border-transparent transition-colors', toneAccent[tone])} /><span className="flex w-5 shrink-0 items-center justify-center ps-1">{loading ? <Loader2 className="h-4 w-4 animate-spin text-primary/70" /> : icon}</span><span className="flex min-w-0 flex-1 flex-col justify-center py-1 text-start"><span className="truncate text-foreground">{label}</span>{description && <span className="truncate text-[10px] leading-tight text-muted-foreground/60">{description}</span>}</span></button>
}

function ContextMenuSection({ label, icon, tone = 'muted' }: {
  label: string
  icon?: React.ReactNode
  tone?: 'muted' | 'primary' | 'warning' | 'info' | 'success' | 'danger'
}) {
  const colors = {
    muted: 'text-muted-foreground/70',
    primary: 'text-primary/75',
    warning: 'text-amber-400/85',
    info: 'text-info/80',
    success: 'text-emerald-400/85',
    danger: 'text-destructive/85',
  }
  return <div className="flex items-center gap-1.5 border-t border-border/30 px-2.5 pt-2 pb-1 font-mono text-[9px] uppercase tracking-[0.2em]"><span className={colors[tone]}>{icon}</span><span className={colors[tone]}>{label}</span><span className="h-px flex-1 bg-border/40" /></div>
}
