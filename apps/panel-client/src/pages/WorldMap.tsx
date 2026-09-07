import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { Trans, useTranslation } from 'react-i18next'
import { getCurrentLanguage, isRTL } from '@/i18n'
import { useTheme } from '@/contexts/ThemeContext'
import { useSocket } from '@/contexts/SocketContext'
import { useAuth } from '@/contexts/AuthContext'
import { DisabledReason } from '@/components/DisabledReason'
import { HelpTip } from '@/components/HelpTip'
import {
  Map as MapIcon,
  Crosshair,
  Users,
  ZoomIn,
  ZoomOut,
  Maximize2,
  RefreshCw,
  Loader2,
  Heart,
  Skull,
  Shield,
  CloudLightning,
  Volume2,
  X,
  Swords,
  Pill,
  UtensilsCrossed,
  Hammer,
  Wrench,
  Target,
  Car,
  Home,
  Fuel,
  Battery,
  Trash2,
  ChevronUp,
  ChevronDown,
  Layers,
  Zap,
  Plus,
  Copy,
  Locate,
  Package,
  Flame,
  BellRing,
  Megaphone,
  Save,
  AlertTriangle,
  ArrowUpRight,
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { BridgeStatusBadge } from '@/components/BridgeStatusBadge'
import { VehiclePicker } from '@/components/VehiclePicker'
import { ItemPicker } from '@/components/ItemPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NumberInput } from '@/components/NumberInput'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { panelBridgeApi, updateApi, serversApi, mapApi, playersApi } from '@/lib/api'
import { getBridgeVerifiedState } from '@/lib/bridgeVerify'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useToast } from '@/components/ui/use-toast'
import { cn, copyText } from '@/lib/utils'
import { createInFlightGate } from '@/lib/inFlightGate'
import { resolveFallbackTile, conservativeRenderedMaxLevel } from './worldMapTileFallback'
import { buildTileQuery } from './worldMapTileUrl'
import { mapConfigsEqual } from './worldMapConfigEqual'
import { bridgeSupportsPlayerStatus } from './worldMapBridgeVersion'
import { diagnoseTileFailure, tileFailureCopyKeys, type TileFailureDiagnosis } from './worldMapTileFailureDiagnosis'

const TILE_RETRY_MS = [2_000, 10_000, 60_000] as const

interface MapPlayer {
  username: string
  displayName?: string
  x: number
  y: number
  z: number
  health?: number
  isAlive?: boolean
  isInfected?: boolean
  accessLevel?: string
  hunger?: number
  thirst?: number
  fatigue?: number
  prevX?: number
  prevY?: number
  animProgress?: number
}

interface RawBridgePlayer {
  name?: string
  username?: string
  displayName?: string
  x: number
  y: number
  z?: number
  health?: number
  isAlive?: boolean
  isInfected?: boolean
  accessLevel?: string
  hunger?: number
  thirst?: number
  fatigue?: number
}

interface ContextMenu {
  screenX: number
  screenY: number
  worldX: number
  worldY: number
  player?: MapPlayer
  vehicle?: MapVehicle
}

interface AirdropMarker {
  x: number
  y: number
  preset: string
  time: number
}

interface MapVehicle {
  id: number
  x: number
  y: number
  persisted?: boolean
  z?: number
  scriptName?: string
  type?: string
  speedKmh?: number
  batteryCharge?: number
  fuelPct?: number
  alarmed?: boolean
  sirening?: boolean
  trunkLocked?: boolean
}

interface MapSafehouse {
  id: string
  title: string
  owner: string
  x: number
  y: number
  w: number
  h: number
  players: string[]
  playerConnected: boolean
  lastVisited?: string
}

const AIRDROP_PRESETS = [
  { id: 'military',  icon: Swords },
  { id: 'medical',   icon: Pill },
  { id: 'food',      icon: UtensilsCrossed },
  { id: 'building',  icon: Hammer },
  { id: 'weapons',   icon: Target },
  { id: 'tools',     icon: Wrench },
] as const


export interface MapConfig {
  tileUrl: string
  tileSize: number
  fullWidth: number
  fullHeight: number
  maxLevel: number
  renderedMaxLevel: number
  isoX0: number
  isoY0: number
  isoHalfSqr: number
  isoQuarterSqr: number
  defaultCenter: { x: number; y: number }
  defaultScale: number
  label: string
}


const MAP_B42: MapConfig = {
  tileUrl: '/api/map/tiles',
  tileSize: 1024,
  fullWidth: 1157312,
  fullHeight: 509520,
  maxLevel: 21,
  renderedMaxLevel: conservativeRenderedMaxLevel(21),
  isoX0: 518144,
  isoY0: -69648,
  isoHalfSqr: 32,
  isoQuarterSqr: 16,
  defaultCenter: { x: 640000, y: 205000 },
  defaultScale: 0.002,
  label: 'B42',
}

const B42_DEFAULT_CENTER_TILE = { x: 10486.75, y: 6678.75 }

const B42_KNOWN_ORIGINS: Record<
  string,
  { x0: number; y0: number; sqr: number; scale: number }
> = {
  // skip:1 -> scale 1<<1 = 2
  '42.19.0': { x0: 1036288, y0: -139296, sqr: 128, scale: 2 },
  // skip:0 -> scale 1<<0 = 1
  '42.20.0': { x0: 1040384, y0: -139296, sqr: 128, scale: 1 },
}

function b42ConfigFor(info: {
  tileSize: number
  width: number
  height: number
  maxLevel: number
  renderedMaxLevel?: number
  b42Dir?: string
  x0?: number
  y0?: number
  sqr?: number
  scale?: number
}): MapConfig {
  const origin =
    Number.isFinite(info.x0) &&
    Number.isFinite(info.y0) &&
    !!info.sqr &&
    !!info.scale
      ? { x0: info.x0!, y0: info.y0!, sqr: info.sqr!, scale: info.scale! }
      : B42_KNOWN_ORIGINS[info.b42Dir ?? ''] || null

  const k = info.width / MAP_B42.fullWidth

  const isoX0 = origin ? origin.x0 / origin.scale : MAP_B42.isoX0 * k
  const isoY0 = origin ? origin.y0 / origin.scale : MAP_B42.isoY0 * k
  const isoHalfSqr = origin
    ? origin.sqr / 2 / origin.scale
    : MAP_B42.isoHalfSqr * k
  const isoQuarterSqr = origin
    ? origin.sqr / 4 / origin.scale
    : MAP_B42.isoQuarterSqr * k

  const cfg: MapConfig = {
    ...MAP_B42,
    tileSize: info.tileSize,
    fullWidth: info.width,
    fullHeight: info.height,
    maxLevel: info.maxLevel,
    renderedMaxLevel: info.renderedMaxLevel ?? conservativeRenderedMaxLevel(info.maxLevel),
    isoX0,
    isoY0,
    isoHalfSqr,
    isoQuarterSqr,
    defaultScale: (MAP_B42.defaultScale * MAP_B42.isoHalfSqr) / isoHalfSqr,
    defaultCenter: MAP_B42.defaultCenter,
  }
  cfg.defaultCenter = gameTileToDzi(
    B42_DEFAULT_CENTER_TILE.x,
    B42_DEFAULT_CENTER_TILE.y,
    cfg,
  )
  return cfg
}

const MAP_B41: MapConfig = {
  tileUrl: '/api/map/b41tiles',
  tileSize: 1024,
  fullWidth: 2285184,
  fullHeight: 990400,
  maxLevel: 22, // ceil(log2(2285184)) = 22
  renderedMaxLevel: conservativeRenderedMaxLevel(22),
  isoX0: 1017856,  // (5577 + 10327) * 64
  isoY0: -152000,  // (5577 - 10327) * 32
  isoHalfSqr: 64,  // 32 * multiply(2)
  isoQuarterSqr: 32, // 16 * multiply(2)
  defaultCenter: { x: 1100000, y: 400000 },
  defaultScale: 0.001,
  label: 'B41',
}

const MIN_SCALE = 0.0003
const MAX_SCALE = 1.0
const POLL_INTERVAL = 3000
const MARKER_HIT_RADIUS = 14
const MAX_FALLBACK_LEVELS = 8

const _carIconCache = new Map<string, HTMLCanvasElement>()

interface CarIconOpts {
  color: string
  size: number
  alarmed?: boolean
  sirening?: boolean
  selected?: boolean
}

function getCarIcon(opts: CarIconOpts): HTMLCanvasElement | null {
  const { color, size, alarmed, sirening, selected } = opts
  if (size < 2) return null
  const pad = Math.ceil(size * 0.2)
  const totalSize = size + pad * 2
  const key = `${color}|${size}|${alarmed ? 1 : 0}|${sirening ? 1 : 0}|${selected ? 1 : 0}`
  let cv = _carIconCache.get(key)
  if (cv) return cv
  cv = document.createElement('canvas')
  cv.width = totalSize
  cv.height = totalSize
  const c = cv.getContext('2d')!

  c.translate(pad, pad)
  const k = size / 24
  c.scale(k, k)

  const bodyX = 6, bodyY = 2.5
  const bodyW = 12, bodyH = 19
  const radius = 3.2

  const grad = c.createLinearGradient(0, bodyY, 0, bodyY + bodyH)
  grad.addColorStop(0, color)
  grad.addColorStop(0.5, color)
  grad.addColorStop(1, 'rgba(0,0,0,0.55)')
  c.fillStyle = grad
  roundRectPath(c, bodyX, bodyY, bodyW, bodyH, radius)
  c.fill()

  c.strokeStyle = 'rgba(0,0,0,0.75)'
  c.lineWidth = 1
  c.lineJoin = 'round'
  roundRectPath(c, bodyX, bodyY, bodyW, bodyH, radius)
  c.stroke()

  c.save()
  c.beginPath()
  roundRectPath(c, bodyX, bodyY, bodyW, bodyH, radius)
  c.clip()
  c.fillStyle = 'rgba(255,255,255,0.14)'
  c.fillRect(bodyX, bodyY, 2.2, bodyH)
  c.restore()

  c.fillStyle = 'rgba(200,230,255,0.35)'
  roundRectPath(c, bodyX + 1.3, bodyY + 3.3, bodyW - 2.6, 4.2, 1.2)
  c.fill()
  c.strokeStyle = 'rgba(0,0,0,0.35)'
  c.lineWidth = 0.6
  c.stroke()

  c.fillStyle = 'rgba(200,230,255,0.22)'
  roundRectPath(c, bodyX + 1.3, bodyY + 11.5, bodyW - 2.6, 3.4, 1.0)
  c.fill()
  c.strokeStyle = 'rgba(0,0,0,0.35)'
  c.stroke()

  c.strokeStyle = 'rgba(0,0,0,0.4)'
  c.lineWidth = 0.5
  c.beginPath()
  c.moveTo(bodyX + 1.3, bodyY + 8.2)
  c.lineTo(bodyX + bodyW - 1.3, bodyY + 8.2)
  c.moveTo(bodyX + 1.3, bodyY + 10.8)
  c.lineTo(bodyX + bodyW - 1.3, bodyY + 10.8)
  c.stroke()

  c.fillStyle = 'rgba(255,235,180,0.92)'
  c.fillRect(bodyX + 1.2, bodyY + 0.6, 2.4, 1.4)
  c.fillRect(bodyX + bodyW - 3.6, bodyY + 0.6, 2.4, 1.4)

  c.fillStyle = 'rgba(220,60,50,0.85)'
  c.fillRect(bodyX + 1.2, bodyY + bodyH - 1.8, 2.2, 1.0)
  c.fillRect(bodyX + bodyW - 3.4, bodyY + bodyH - 1.8, 2.2, 1.0)

  c.fillStyle = 'rgba(15,15,15,0.9)'
  c.fillRect(bodyX - 1, bodyY + 2.8, 1.8, 3.2)
  c.fillRect(bodyX + bodyW - 0.8, bodyY + 2.8, 1.8, 3.2)
  c.fillRect(bodyX - 1, bodyY + bodyH - 6, 1.8, 3.2)
  c.fillRect(bodyX + bodyW - 0.8, bodyY + bodyH - 6, 1.8, 3.2)

  if (selected) {
    c.strokeStyle = 'rgba(255,255,255,0.85)'
    c.lineWidth = 1.2
    roundRectPath(c, bodyX - 1.8, bodyY - 1.2, bodyW + 3.6, bodyH + 2.4, radius + 1.8)
    c.stroke()
  }

  if (sirening) {
    c.fillStyle = 'rgba(80,140,255,1)'
    c.fillRect(bodyX + 2.6, bodyY + 9.1, 3.2, 1.5)
    c.fillStyle = 'rgba(255,70,70,1)'
    c.fillRect(bodyX + bodyW - 5.8, bodyY + 9.1, 3.2, 1.5)
  }

  if (alarmed) {
    c.fillStyle = 'rgba(255,170,40,0.95)'
    c.beginPath()
    c.arc(bodyX + bodyW / 2, bodyY - 1.8, 1.8, 0, Math.PI * 2)
    c.fill()
    c.strokeStyle = 'rgba(0,0,0,0.5)'
    c.lineWidth = 0.5
    c.stroke()
  }

  if (_carIconCache.size > 200) _carIconCache.clear()
  _carIconCache.set(key, cv)
  return cv
}

function roundRectPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  c.beginPath()
  c.moveTo(x + rr, y)
  c.lineTo(x + w - rr, y)
  c.quadraticCurveTo(x + w, y, x + w, y + rr)
  c.lineTo(x + w, y + h - rr)
  c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  c.lineTo(x + rr, y + h)
  c.quadraticCurveTo(x, y + h, x, y + h - rr)
  c.lineTo(x, y + rr)
  c.quadraticCurveTo(x, y, x + rr, y)
  c.closePath()
}


function hslToken(prop: string, alpha?: number): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(prop).trim()
  if (!raw) return alpha !== undefined ? `rgba(128,128,128,${alpha})` : '#808080'
  return alpha !== undefined ? `hsl(${raw} / ${alpha})` : `hsl(${raw})`
}

function resolveCanvasColors() {
  return {
    background: hslToken('--background'),
    landmarkGlow: 'rgba(255,255,255,0.04)',
    landmarkDiamond: hslToken('--foreground', 0.35),
    landmarkLabel: hslToken('--foreground', 0.65),
    shadowLight: 'rgba(0,0,0,0.4)',
    shadowMedium: 'rgba(0,0,0,0.45)',
    shadowStrong: 'rgba(0,0,0,0.6)',
    shadowDarker: 'rgba(0,0,0,0.7)',
    shadowOpaque: 'rgba(0,0,0,1)',
    headHighlight: 'rgba(255,255,255,0.3)',
    playerRim: 'rgba(10,12,16,0.92)',
    playerGlyph: 'rgba(10,12,16,0.85)',
    playerInfectedRing: hslToken('--destructive', 0.85),
    adminStar: hslToken('--warning', 0.9),
    healthBarBg: 'rgba(0,0,0,0.5)',
    healthGood: hslToken('--success', 0.8),
    healthWarning: hslToken('--warning', 0.8),
    healthCritical: hslToken('--destructive', 0.8),
    playerDefault: hslToken('--info', 0.92),
    playerAdmin: hslToken('--warning', 0.92),
    playerInfected: hslToken('--destructive', 0.92),
    playerDead: hslToken('--muted-foreground', 0.7),
    crateBody: hslToken('--accent', 0.92),
    crateBorder: hslToken('--accent', 0.6),
    crateStraps: hslToken('--warning', 0.7),
    airdropRing: hslToken('--warning', 0.4),
    airdropLine: hslToken('--foreground', 0.5),
    airdropCanopyStroke: hslToken('--warning', 0.85),
    airdropCanopyFill: hslToken('--warning', 0.12),
    airdropLabel: hslToken('--warning', 0.9),
    emptyTitle: hslToken('--foreground', 0.15),
    emptySubtitle: hslToken('--foreground', 0.08),
    crosshair: hslToken('--foreground', 0.12),
    usernameLabel: hslToken('--foreground'),
    vehicleMarker: hslToken('--info', 0.85),
    vehicleMarkerHover: hslToken('--info', 1),
    vehicleLabel: hslToken('--info', 0.8),
    vehicleGlow: hslToken('--info', 0.15),
    vehicleFuelWarn: hslToken('--warning', 0.85),
    vehicleFuelCrit: hslToken('--destructive', 0.85),
    safehouseFill: hslToken('--success', 0.08),
    safehouseStroke: hslToken('--success', 0.45),
    safehouseStrokeActive: hslToken('--success', 0.7),
    safehouseLabel: hslToken('--success', 0.75),
  }
}

type CanvasColors = ReturnType<typeof resolveCanvasColors>

const PZ_LANDMARKS = [
  { name: 'Muldraugh',      gx: 10630, gy:  9800 },
  { name: 'West Point',     gx: 11900, gy:  6900 },
  { name: 'Rosewood',       gx:  8090, gy: 11500 },
  { name: 'Riverside',      gx:  6100, gy:  5400 },
  { name: 'Louisville',     gx: 12700, gy:  1700 },
  { name: 'March Ridge',    gx: 10100, gy: 12700 },
  { name: 'Valley Station', gx: 13200, gy:  5300 },
  { name: 'Fallas Lake',    gx:  7460, gy:  9050 },
  { name: 'Ekron',          gx:   550, gy:  9750 },
  { name: 'Brandenburg',    gx:  2100, gy:  6080 },
  { name: 'Irvington',      gx:  2500, gy: 14250 },
  { name: 'Echo Creek',     gx:  3520, gy: 10930 },
]

export default function WorldMap() {
  const { t } = useTranslation('worldMap')
  const { theme } = useTheme()
  const socket = useSocket()
  const { can } = useAuth()
  const canRunBridgeCommand = can('bridge.command')
  const canWorldEvents = can('server.world_events')
  const canGmTools = can('players.gm_tools')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const mapWrapperRef = useRef<HTMLDivElement>(null)
  const animFrameRef = useRef<number>(0)
  const playerFetchGateRef = useRef(createInFlightGate())
  const overlayFetchGateRef = useRef(createInFlightGate())
  const playersRef = useRef<MapPlayer[]>([])
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null)
  const drawRequestRef = useRef<number>(0)
  const canvasColorsRef = useRef<CanvasColors>(resolveCanvasColors())

  const [players, setPlayers] = useState<MapPlayer[]>([])
  const [rosterCollapsed, setRosterCollapsed] = useState(false)
  const [mapCfg, setMapCfg] = useState<MapConfig>(MAP_B42)
  const mapCfgRef = useRef<MapConfig>(MAP_B42)
  const [scale, setScale] = useState(MAP_B42.defaultScale)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const contextMenuWasOpenRef = useRef(false)
  useEffect(() => {
    if (contextMenu) {
      contextMenuWasOpenRef.current = true
    } else if (contextMenuWasOpenRef.current) {
      contextMenuWasOpenRef.current = false
      canvasRef.current?.focus()
    }
  }, [contextMenu])
  const [selectedPlayer, setSelectedPlayer] = useState<MapPlayer | null>(null)
  const [bridgeConnected, setBridgeConnected] = useState(false)
  const [bridgeLoading, setBridgeLoading] = useState(false)
  const [bridgeVersion, setBridgeVersion] = useState<string | null>(null)
  const bridgeVersionRef = useRef<string | null>(null)
  useEffect(() => { bridgeVersionRef.current = bridgeVersion }, [bridgeVersion])
  const [hasActiveServer, setHasActiveServer] = useState(false)
  const [loading, setLoading] = useState(true)
  const [hoveredPlayer, setHoveredPlayer] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0, offX: 0, offY: 0 })
  const [cursorWorldPos, setCursorWorldPos] = useState<{ x: number; y: number } | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const actionLoadingRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  const hasFittedRef = useRef(false)
  const [airdropMarkers, setAirdropMarkers] = useState<AirdropMarker[]>([])
  const [vehicles, setVehicles] = useState<MapVehicle[]>([])
  const [safehouses, setSafehouses] = useState<MapSafehouse[]>([])
  const [showVehicles, setShowVehicles] = useState(true)
  const [showSafehouses, setShowSafehouses] = useState(true)
  const [hoveredVehicle, setHoveredVehicle] = useState<number | null>(null)
  const vehiclesRef = useRef<MapVehicle[]>([])
  const safehousesRef = useRef<MapSafehouse[]>([])
  const [spawnDialog, setSpawnDialog] = useState<{ x: number; y: number; z: number } | null>(null)
  const [spawnVehicleId, setSpawnVehicleId] = useState('')
  const [dropDialog, setDropDialog] = useState<{ x: number; y: number; z: number } | null>(null)
  const [dropItems, setDropItems] = useState<Array<{ itemType: string; count: number }>>([
    { itemType: '', count: 1 },
  ])
  const [dropAnnounce, setDropAnnounce] = useState(true)
  const [dropAttractZombies, setDropAttractZombies] = useState(true)
  const [dropSoundRadius, setDropSoundRadius] = useState(150)
  const [lastDrop, setLastDrop] = useState<{
    items: Array<{ itemType: string; count: number }>
    label: string
  } | null>(null)
  interface DropTemplate {
    id: string
    name: string
    items: Array<{ itemType: string; count: number }>
  }
  const DROP_TEMPLATES_KEY = 'worldmap.customDropTemplates.v1'
  const [dropTemplates, setDropTemplates] = useState<DropTemplate[]>(() => {
    try {
      const raw = localStorage.getItem(DROP_TEMPLATES_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (t) =>
          t &&
          typeof t.id === 'string' &&
          typeof t.name === 'string' &&
          Array.isArray(t.items)
      )
    } catch {
      return []
    }
  })
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null)
  const [deleteTemplateId, setDeleteTemplateId] = useState<string | null>(null)
  const [removeVehicleTarget, setRemoveVehicleTarget] = useState<{ id: number; label: string; x: number; y: number } | null>(null)
  const [templateNameInput, setTemplateNameInput] = useState('')
  const [savingTemplate, setSavingTemplate] = useState(false)
  const persistDropTemplates = useCallback((next: DropTemplate[]) => {
    setDropTemplates(next)
    try {
      localStorage.setItem(DROP_TEMPLATES_KEY, JSON.stringify(next))
    } catch {
      // localStorage full / unavailable — silent
    }
  }, [])
  const [floor, setFloor] = useState(0)
  const floorRef = useRef(0)
  const { toast } = useToast()

  const floorLabel = (f: number) =>
    f === 0 ? t('floor.ground') : f > 0 ? t('floor.floorN', { n: f }) : t('floor.basementN', { n: Math.abs(f) })

  const presetLabel = useCallback((id: string) => t(`airdropPresets.${id}.label`), [t])
  const presetDesc = useCallback((id: string) => t(`airdropPresets.${id}.desc`), [t])

  const changeFloor = useCallback((newFloor: number) => {
    const clamped = Math.max(-1, Math.min(7, newFloor))
    setFloor(clamped)
    floorRef.current = clamped
    const oldCache = tileCacheRef.current
    tileCacheRef.current = {}
    void oldCache
    tileFailRef.current = {}
    tileFailureCountRef.current = 0
    setTileLoadFailing(false)
    if (drawRequestRef.current === 0) {
      drawRequestRef.current = requestAnimationFrame(() => { drawRequestRef.current = 0 })
    }
  }, [])

  const detectServerVersion = useCallback(async (cancelledRef: { current: boolean }) => {
    try {
      const [statusRes, serverRes] = await Promise.allSettled([
        updateApi.getStatus(),
        serversApi.getResolvedActive(),
      ])
      if (cancelledRef.current) return

      let isB41 = false
      if (serverRes.status === 'fulfilled') {
        setHasActiveServer(!!serverRes.value.server)
      } else {
        setHasActiveServer(false)
      }
      if (statusRes.status === 'fulfilled' && statusRes.value.gameVersion) {
        isB41 = statusRes.value.gameVersion.startsWith('41.')
      }
      if (!isB41 && serverRes.status === 'fulfilled') {
        const branch = serverRes.value.server?.branch
        if (branch && /b41/i.test(branch)) isB41 = true
      }

      const targetCfg = isB41 ? MAP_B41 : b42ConfigFor(await mapApi.resolve())
      if (cancelledRef.current) return
      const cur = mapCfgRef.current
      if (mapConfigsEqual(cur, targetCfg)) return

      setMapCfg(targetCfg)
      mapCfgRef.current = targetCfg
      if (isB41) {
        setFloor(0)
        floorRef.current = 0
      }
      tileCacheRef.current = {}
      tileFailRef.current = {}
      tileFailureCountRef.current = 0
      setTileLoadFailing(false)
      const el = containerRef.current
      if (el) {
        const s = targetCfg.defaultScale
        const c = targetCfg.defaultCenter
        setScale(s)
        setOffset({
          x: el.clientWidth / 2 - c.x * s,
          y: el.clientHeight / 2 - c.y * s,
        })
      }
    } catch { /* best-effort */ }
  }, [])

  useEffect(() => {
    const cancelledRef = { current: false }
    detectServerVersion(cancelledRef)
    return () => { cancelledRef.current = true }
  }, [detectServerVersion])

  useEffect(() => {
    if (!socket) return
    const cancelledRef = { current: false }
    const handleActiveServerChanged = () => {
      setPlayers([])
      setVehicles([])
      setSafehouses([])
      setSelectedPlayer(null)
      setContextMenu(null)
      hasFittedRef.current = false
      detectServerVersion(cancelledRef)
    }
    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      cancelledRef.current = true
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, detectServerVersion])

  useEffect(() => {
    if (hasActiveServer) return
    setBridgeConnected(false)
    setBridgeLoading(false)
    setPlayers([])
    setVehicles([])
    setSafehouses([])
    setLoading(false)
  }, [hasActiveServer])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const prefersReducedMotion = useRef(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    prefersReducedMotion.current = mq.matches
    const handler = (e: MediaQueryListEvent) => { prefersReducedMotion.current = e.matches }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const offsetRef = useRef(offset)
  offsetRef.current = offset
  const airdropMarkersRef = useRef(airdropMarkers)
  airdropMarkersRef.current = airdropMarkers
  useEffect(() => { vehiclesRef.current = vehicles }, [vehicles])
  useEffect(() => { safehousesRef.current = safehouses }, [safehouses])

  const tileCacheRef = useRef<Record<string, HTMLImageElement | null | 'empty'>>({})

  const mapSourceRef = useRef<{ root: string; b42Dir: string; b41Path: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    mapApi.resolve()
      .then((info) => { if (!cancelled) mapSourceRef.current = info })
      .catch(() => { /* direct loading just won't be attempted; proxy fallback still works */ })
    return () => { cancelled = true }
  }, [])

  const buildDirectTileUrl = useCallback((level: number, col: number, row: number, floor: number, ext: string) => {
    const src = mapSourceRef.current
    if (!src) return null
    if (mapCfgRef.current === MAP_B41) {
      return `${src.root}/${src.b41Path}/${level}/${col}_${row}.${ext}`
    }
    return `${src.root}/${src.b42Dir}/base/layer${floor}_files/${level}/${col}_${row}.${ext}`
  }, [])

  const pendingTileLoadsRef = useRef(0)
  const MAX_CONCURRENT_TILES = 8

  const tileFailRef = useRef<Record<string, { count: number; nextAt: number }>>({})
  const tileFailureCountRef = useRef(0)
  const [tileLoadFailing, setTileLoadFailing] = useState(false)
  const [tileFailureKind, setTileFailureKind] = useState<'network' | 'coverage'>('network')
  const tileCoverageFailRef = useRef(0)
  const [tileByteDiagnosis, setTileByteDiagnosis] = useState<TileFailureDiagnosis | null>(null)
  const [tileFailureDetail, setTileFailureDetail] = useState<string | null>(null)

  const loadDziTile = useCallback((level: number, col: number, row: number) => {
    const f = floorRef.current
    const key = `${f}/${level}/${col}_${row}`
    if (key in tileCacheRef.current) return
    if (pendingTileLoadsRef.current >= MAX_CONCURRENT_TILES) return
    const fail = tileFailRef.current[key]
    if (fail && Date.now() < fail.nextAt) return
    tileCacheRef.current[key] = null
    pendingTileLoadsRef.current++

    const markFailed = (
      reason: 'network' | 'coverage' = 'network',
      detail: string = 'no-header',
      diagnosis: TileFailureDiagnosis | null = null,
    ) => {
      if (floorRef.current !== f) return
      delete tileCacheRef.current[key]
      const prev = tileFailRef.current[key]
      const count = (prev?.count ?? 0) + 1
      const delay = TILE_RETRY_MS[Math.min(count - 1, TILE_RETRY_MS.length - 1)]
      tileFailRef.current[key] = { count, nextAt: Date.now() + delay }
      if (count === 1) {
        setTileFailureDetail(detail)
        setTileByteDiagnosis(diagnosis)
        tileFailureCountRef.current++
        if (reason === 'coverage') tileCoverageFailRef.current++
        if (tileFailureCountRef.current >= 6) {
          setTileFailureKind(
            tileCoverageFailRef.current * 2 >= tileFailureCountRef.current
              ? 'coverage'
              : 'network',
          )
          setTileLoadFailing(true)
        }
      }
    }

    const markRecovered = () => {
      if (tileFailRef.current[key]) {
        delete tileFailRef.current[key]
        if (tileFailureCountRef.current > 0) {
          tileFailureCountRef.current = Math.max(0, tileFailureCountRef.current - 1)
          if (tileFailureCountRef.current === 0) {
            tileCoverageFailRef.current = 0
            setTileLoadFailing(false)
            setTileFailureDetail(null)
            setTileByteDiagnosis(null)
          }
        }
      }
    }

    const ext = 'jpg'
    const isB41 = mapCfgRef.current === MAP_B41
    const versionDir = !isB41 ? (mapSourceRef.current?.b42Dir ?? null) : null
    const proxyUrl = `${mapCfgRef.current.tileUrl}/${level}/${col}_${row}.${ext}${buildTileQuery(f, versionDir)}`

    const loadViaProxy = () => {
      let upstreamParticipated = false
      let cacheTierRaw: string | null = null
      let contentLengthHeader: string | null = null
      fetch(proxyUrl)
        .then((res) => {
          cacheTierRaw = res.headers.get('X-Tile-Cache')
          contentLengthHeader = res.headers.get('Content-Length')
          upstreamParticipated = cacheTierRaw === 'miss'
          if (floorRef.current !== f) { pendingTileLoadsRef.current--; return null }
          if (res.status === 404) {
            pendingTileLoadsRef.current--
            tileCacheRef.current[key] = 'empty'
            markRecovered()
            return null
          }
          if (!res.ok) {
            const err = new Error(`HTTP ${res.status}`) as Error & { status?: number }
            err.status = res.status
            throw err
          }
          return res.blob()
        })
        .then((blob) => {
          if (!blob) return
          if (floorRef.current !== f) { pendingTileLoadsRef.current--; return }
          const objectUrl = URL.createObjectURL(blob)
          const img = new window.Image()
          img.onload = () => {
            URL.revokeObjectURL(objectUrl)
            pendingTileLoadsRef.current--
            if (floorRef.current !== f) return
            tileCacheRef.current[key] = img
            markRecovered()
            if (drawRequestRef.current === 0) {
              drawRequestRef.current = requestAnimationFrame(() => { drawRequestRef.current = 0 })
            }
          }
          img.onerror = () => {
            URL.revokeObjectURL(objectUrl)
            pendingTileLoadsRef.current--
            blob.slice(0, 4).arrayBuffer()
              .then((buf) => {
                const diagnosis = diagnoseTileFailure(new Uint8Array(buf), blob.size, contentLengthHeader)
                markFailed(upstreamParticipated ? 'coverage' : 'network', cacheTierRaw ?? 'no-header', diagnosis)
              })
              .catch(() => {
                markFailed(upstreamParticipated ? 'coverage' : 'network', cacheTierRaw ?? 'no-header')
              })
          }
          img.src = objectUrl
        })
        .catch((err) => {
          pendingTileLoadsRef.current--
          const status = (err as { status?: number } | undefined)?.status
          markFailed(
            upstreamParticipated && status && status >= 400 && status < 500 ? 'coverage' : 'network',
            cacheTierRaw ?? (status ? `http-${status}` : 'unreachable'),
          )
        })
    }

    const directUrl = buildDirectTileUrl(level, col, row, f, ext)
    if (!directUrl) {
      loadViaProxy()
      return
    }

    const directImg = new window.Image()
    directImg.onload = () => {
      if (floorRef.current !== f) { pendingTileLoadsRef.current--; return }
      tileCacheRef.current[key] = directImg
      markRecovered()
      pendingTileLoadsRef.current--
      if (drawRequestRef.current === 0) {
        drawRequestRef.current = requestAnimationFrame(() => { drawRequestRef.current = 0 })
      }
    }
    directImg.onerror = () => {
      if (floorRef.current !== f) { pendingTileLoadsRef.current--; return }
      loadViaProxy()
    }
    directImg.src = directUrl
  }, [buildDirectTileUrl])

  const drawTileWithFallback = useCallback((
    ctx: CanvasRenderingContext2D,
    floor: number,
    level: number,
    col: number,
    row: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ) => {
    const fallback = resolveFallbackTile(
      level,
      col,
      row,
      (l, c, r) => tileCacheRef.current[`${floor}/${l}/${c}_${r}`],
      (l, c, r) => loadDziTile(l, c, r),
      MAX_FALLBACK_LEVELS,
    )
    if (!fallback) return false
    ctx.drawImage(fallback.img, fallback.srcX, fallback.srcY, fallback.srcW, fallback.srcH, dx, dy, dw, dh)
    return true
  }, [loadDziTile])

  const dziToCanvas = useCallback(
    (dziX: number, dziY: number, s?: number, off?: { x: number; y: number }) => {
      const sc = s ?? scaleRef.current
      const o = off ?? offsetRef.current
      return { x: dziX * sc + o.x, y: dziY * sc + o.y }
    }, []
  )

  const canvasToDzi = useCallback(
    (cx: number, cy: number, s?: number, off?: { x: number; y: number }) => {
      const sc = s ?? scaleRef.current
      const o = off ?? offsetRef.current
      return { x: (cx - o.x) / sc, y: (cy - o.y) / sc }
    }, []
  )

  const playerToScreen = useCallback(
    (gx: number, gy: number, s?: number, off?: { x: number; y: number }) => {
      const dzi = gameTileToDzi(gx, gy, mapCfgRef.current)
      return dziToCanvas(dzi.x, dzi.y, s, off)
    }, [dziToCanvas]
  )

  const playerRenderPosition = useCallback(
    (player: MapPlayer, s?: number, off?: { x: number; y: number }) => {
      let drawX = player.x
      let drawY = player.y
      if (!prefersReducedMotion.current && player.animProgress !== undefined && player.animProgress < 1) {
        const progress = easeOutCubic(Math.min(1, player.animProgress))
        drawX = (player.prevX ?? player.x) + (player.x - (player.prevX ?? player.x)) * progress
        drawY = (player.prevY ?? player.y) + (player.y - (player.prevY ?? player.y)) * progress
      }
      return playerToScreen(drawX, drawY, s, off)
    }, [playerToScreen]
  )

  const playerAtScreenPoint = useCallback(
    (mx: number, my: number) => {
      const markerRadius = Math.max(5, Math.min(16, scaleRef.current * 1400))
      let closest: MapPlayer | null = null
      let closestDistance = Number.POSITIVE_INFINITY
      for (const player of playersRef.current) {
        const point = playerRenderPosition(player)
        const distance = Math.hypot(mx - point.x, my - point.y)
        const hitRadius = Math.max(MARKER_HIT_RADIUS, markerRadius + 8)
        if (distance < hitRadius && distance < closestDistance) {
          closest = player
          closestDistance = distance
        }
      }
      return closest
    }, [playerRenderPosition]
  )

  const screenToTile = useCallback(
    (cx: number, cy: number, s?: number, off?: { x: number; y: number }) => {
      const dzi = canvasToDzi(cx, cy, s, off)
      return dziToGameTile(dzi.x, dzi.y, mapCfgRef.current)
    }, [canvasToDzi]
  )

  const fetchPlayerPositions = useCallback(async () => {
    if (!hasActiveServer) {
      setBridgeConnected(false)
      setPlayers([])
      setLoading(false)
      return
    }
    if (!playerFetchGateRef.current.enter()) return

    try {
      const res = await panelBridgeApi.getServerInfo()
      const rawPlayers = res.success && res.data?.players
        ? (Array.isArray(res.data.players) ? res.data.players : Object.values(res.data.players))
        : null
      if (rawPlayers) {
        setBridgeConnected(true)
        const statusFieldsSupported = bridgeSupportsPlayerStatus(bridgeVersionRef.current)
        setPlayers((prev) => {
          const prevMap = new globalThis.Map(prev.map((p) => [p.username || p.displayName, p]))
          return rawPlayers.map((p: RawBridgePlayer) => {
            const key = (p.name || p.username) as string
            const old = prevMap.get(key)
            return {
              username: key,
              displayName: p.displayName || key,
              x: p.x, y: p.y, z: p.z ?? 0,
              health: p.health,
              isAlive: statusFieldsSupported ? p.isAlive : undefined,
              isInfected: statusFieldsSupported ? p.isInfected : undefined,
              accessLevel: statusFieldsSupported ? p.accessLevel : undefined,
              hunger: p.hunger, thirst: p.thirst, fatigue: p.fatigue,
              prevX: old ? old.x : p.x,
              prevY: old ? old.y : p.y,
              animProgress: old && (old.x !== p.x || old.y !== p.y) ? 0 : 1,
            }
          })
        })
      }
    } catch {
      setBridgeConnected(false)
    } finally {
      playerFetchGateRef.current.leave()
      setLoading(false)
    }
  }, [hasActiveServer])

  const checkBridgeStatus = useCallback(async () => {
    if (!hasActiveServer) {
      setBridgeConnected(false)
      setBridgeVersion(null)
      setBridgeLoading(false)
      return
    }

    setBridgeLoading(true)
    try {
      const res = await panelBridgeApi.getStatus()
      setBridgeConnected(res.modConnected === true)
      setBridgeVersion(res.modStatus?.version || null)
    } catch {
      setBridgeConnected(false)
      setBridgeVersion(null)
    } finally {
      setBridgeLoading(false)
    }
  }, [hasActiveServer])

  const fetchOverlays = useCallback(async () => {
    if (!mountedRef.current || !hasActiveServer) return
    if (!overlayFetchGateRef.current.enter()) return
    try {
      const [vRes, persistedRes, sRes] = await Promise.allSettled([
        showVehicles ? panelBridgeApi.sendCommand('getVehiclesDetailed') : Promise.resolve(null),
        showVehicles ? mapApi.vehicles() : Promise.resolve(null),
        panelBridgeApi.sendCommand('getSafehouses'),
      ])
      if (!mountedRef.current) return
      if (showVehicles) {
        const vehicleById = new Map<number, MapVehicle>()
        if (persistedRes.status === 'fulfilled' && persistedRes.value) {
          for (const vehicle of persistedRes.value.vehicles) {
            if (Number.isFinite(vehicle.id) && Number.isFinite(vehicle.x) && Number.isFinite(vehicle.y)) {
              vehicleById.set(vehicle.id, { ...vehicle, persisted: true })
            }
          }
        }
        if (vRes.status === 'fulfilled' && vRes.value && vRes.value.success && vRes.value.data) {
          const vData = vRes.value.data as Record<string, unknown>
          const vList = Array.isArray(vData) ? vData : Array.isArray(vData.vehicles) ? vData.vehicles : []
          for (const vehicle of vList as MapVehicle[]) {
            if (typeof vehicle.id === 'number' && typeof vehicle.x === 'number' && typeof vehicle.y === 'number' && isFinite(vehicle.x) && isFinite(vehicle.y)) {
              vehicleById.set(vehicle.id, vehicle)
            }
          }
        }
        setVehicles([...vehicleById.values()])
      }
      if (sRes.status === 'fulfilled' && sRes.value.success && sRes.value.data) {
        const sData = sRes.value.data as Record<string, unknown>
        const sList = Array.isArray(sData) ? sData : Array.isArray(sData.safehouses) ? sData.safehouses : []
        setSafehouses((sList as MapSafehouse[]).filter(s => typeof s.x === 'number' && typeof s.y === 'number' && isFinite(s.x) && isFinite(s.y)))
      }
    } catch { /* best-effort */
    } finally {
      overlayFetchGateRef.current.leave()
    }
  }, [hasActiveServer, showVehicles])

  useEffect(() => {
    checkBridgeStatus()
    fetchPlayerPositions()
  }, [fetchPlayerPositions, checkBridgeStatus])

  useEffect(() => {
    if (!hasActiveServer || !bridgeConnected) return
    fetchOverlays()
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') fetchOverlays()
    }, 15_000)
    return () => clearInterval(interval)
  }, [bridgeConnected, fetchOverlays, hasActiveServer])

  useEffect(() => {
    if (!hasActiveServer) return
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') fetchPlayerPositions()
    }, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchPlayerPositions, hasActiveServer])

  useEffect(() => { playersRef.current = players }, [players])


  useEffect(() => {
    canvasColorsRef.current = resolveCanvasColors()
    _carIconCache.clear()
  }, [theme])

  const drawMap = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || canvasSize.width === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const C = canvasColorsRef.current

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(canvasSize.width * dpr)
    canvas.height = Math.floor(canvasSize.height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const W = canvasSize.width
    const H = canvasSize.height
    const s = scaleRef.current
    const off = offsetRef.current

    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    ctx.fillStyle = C.background
    ctx.fillRect(0, 0, W, H)

    const mc = mapCfgRef.current
    const level = Math.max(0, Math.min(mc.renderedMaxLevel, Math.round(mc.maxLevel + Math.log2(s))))
    const levelScale = Math.pow(2, mc.maxLevel - level)
    const levelW = Math.ceil(mc.fullWidth / levelScale)
    const levelH = Math.ceil(mc.fullHeight / levelScale)

    const visMinDziX = -off.x / s
    const visMaxDziX = (W - off.x) / s
    const visMinDziY = -off.y / s
    const visMaxDziY = (H - off.y) / s

    const tileSize = mc.tileSize
    const minCol = Math.max(0, Math.floor(visMinDziX / levelScale / tileSize))
    const maxCol = Math.min(Math.ceil(levelW / tileSize) - 1, Math.floor(visMaxDziX / levelScale / tileSize))
    const minRow = Math.max(0, Math.floor(visMinDziY / levelScale / tileSize))
    const maxRow = Math.min(Math.ceil(levelH / tileSize) - 1, Math.floor(visMaxDziY / levelScale / tileSize))

    ctx.save()
    ctx.globalAlpha = 0.9
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        loadDziTile(level, col, row)
        const img = tileCacheRef.current[`${floorRef.current}/${level}/${col}_${row}`]
        const dx = Math.floor(col * tileSize * levelScale * s + off.x)
        const dy = Math.floor(row * tileSize * levelScale * s + off.y)
        if (img && img !== 'empty') {
          const dw = Math.ceil(img.naturalWidth * levelScale * s) + 1
          const dh = Math.ceil(img.naturalHeight * levelScale * s) + 1
          ctx.drawImage(img, dx, dy, dw, dh)
        } else {
          const dw = Math.ceil(tileSize * levelScale * s) + 1
          const dh = Math.ceil(tileSize * levelScale * s) + 1
          drawTileWithFallback(ctx, floorRef.current, level, col, row, dx, dy, dw, dh)
        }
      }
    }
    ctx.restore()

    const markerSize = Math.max(4, Math.min(10, s * 1500))
    const fontSize = Math.max(9, Math.min(14, s * 3000))
    ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`
    ctx.textAlign = 'center'

    for (const lm of PZ_LANDMARKS) {
      const p = playerToScreen(lm.gx, lm.gy, s, off)
      if (p.x < -100 || p.x > W + 100 || p.y < -50 || p.y > H + 50) continue

      ctx.beginPath()
      ctx.arc(p.x, p.y, markerSize * 2, 0, Math.PI * 2)
      ctx.fillStyle = C.landmarkGlow
      ctx.fill()

      ctx.beginPath()
      ctx.moveTo(p.x, p.y - markerSize * 0.7)
      ctx.lineTo(p.x + markerSize * 0.7, p.y)
      ctx.lineTo(p.x, p.y + markerSize * 0.7)
      ctx.lineTo(p.x - markerSize * 0.7, p.y)
      ctx.closePath()
      ctx.fillStyle = C.landmarkDiamond
      ctx.fill()

      const labelWidth = ctx.measureText(lm.name).width
      const labelY = p.y - markerSize - 4
      const labelFits =
        p.x - labelWidth / 2 >= 0 &&
        p.x + labelWidth / 2 <= W &&
        labelY - fontSize >= 0 &&
        labelY <= H
      if (labelFits) {
        ctx.fillStyle = C.landmarkLabel
        ctx.fillText(lm.name, p.x, labelY)
      }
    }

    if (showSafehouses) {
      const currentSafehouses = safehousesRef.current
      for (const sh of currentSafehouses) {
        const topLeft = playerToScreen(sh.x, sh.y, s, off)
        const bottomRight = playerToScreen(sh.x + sh.w, sh.y + sh.h, s, off)
        const topRight = playerToScreen(sh.x + sh.w, sh.y, s, off)
        const bottomLeft = playerToScreen(sh.x, sh.y + sh.h, s, off)

        const allX = [topLeft.x, topRight.x, bottomRight.x, bottomLeft.x]
        const allY = [topLeft.y, topRight.y, bottomRight.y, bottomLeft.y]
        const minPx = Math.min(...allX)
        const maxPx = Math.max(...allX)
        const minPy = Math.min(...allY)
        const maxPy = Math.max(...allY)
        if (maxPx < -50 || minPx > W + 50 || maxPy < -50 || minPy > H + 50) continue

        ctx.beginPath()
        ctx.moveTo(topLeft.x, topLeft.y)
        ctx.lineTo(topRight.x, topRight.y)
        ctx.lineTo(bottomRight.x, bottomRight.y)
        ctx.lineTo(bottomLeft.x, bottomLeft.y)
        ctx.closePath()
        ctx.fillStyle = C.safehouseFill
        ctx.fill()
        ctx.strokeStyle = sh.playerConnected ? C.safehouseStrokeActive : C.safehouseStroke
        ctx.lineWidth = sh.playerConnected ? 2 : 1
        ctx.stroke()

        if (s > 0.0008) {
          const centerX = (minPx + maxPx) / 2
          const centerY = (minPy + maxPy) / 2
          const shFontSize = Math.max(8, Math.min(11, s * 2000))
          ctx.font = `600 ${shFontSize}px ui-sans-serif, system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.fillStyle = C.safehouseLabel
          const displayName = sh.title || sh.owner || t('safehouseFallback')
          ctx.fillText(displayName, centerX, centerY - 2)
          if (sh.owner && sh.owner !== displayName) {
            ctx.font = `400 ${shFontSize * 0.85}px ui-sans-serif, system-ui, sans-serif`
            ctx.fillText(sh.owner, centerX, centerY + shFontSize)
          }
        }
      }
    }

    const now = performance.now()
    if (showVehicles) {
      const currentVehicles = vehiclesRef.current
      const vSize = Math.max(14, Math.min(36, s * 4200))

      for (const vehicle of currentVehicles) {
        const vp = playerToScreen(vehicle.x, vehicle.y, s, off)
        if (vp.x < -40 || vp.x > W + 40 || vp.y < -40 || vp.y > H + 40) continue

        const isHovered = hoveredVehicle === vehicle.id
        const drawSize = isHovered ? vSize * 1.2 : vSize
        const half = drawSize / 2

        const vColor = vehicle.fuelPct == null
          ? C.vehicleMarker
          : vehicle.fuelPct > 30
            ? C.vehicleMarker
            : vehicle.fuelPct > 10
              ? C.vehicleFuelWarn
              : C.vehicleFuelCrit
        const color = isHovered ? C.vehicleMarkerHover : vColor

        if (isHovered) {
          ctx.beginPath()
          ctx.arc(vp.x, vp.y, half + 6, 0, Math.PI * 2)
          ctx.fillStyle = C.vehicleGlow
          ctx.fill()
        }

        if (vehicle.sirening && !prefersReducedMotion.current) {
          const sirenPhase = (now / 450) % 1
          const sirenR = half + 8 + sirenPhase * 6
          const sirenColor = sirenPhase < 0.5 ? 'hsl(210 95% 60%)' : 'hsl(0 85% 60%)'
          ctx.beginPath()
          ctx.arc(vp.x, vp.y, sirenR, 0, Math.PI * 2)
          ctx.strokeStyle = sirenColor
          ctx.globalAlpha = 0.45 * (1 - sirenPhase)
          ctx.lineWidth = 2
          ctx.stroke()
          ctx.globalAlpha = 1
        }

        if (vehicle.alarmed && !prefersReducedMotion.current) {
          const alarmPhase = (now / 900) % 1
          const alarmR = half + 4 + alarmPhase * 10
          ctx.beginPath()
          ctx.arc(vp.x, vp.y, alarmR, 0, Math.PI * 2)
          ctx.strokeStyle = hslToken('--warning', 0.45 * (1 - alarmPhase))
          ctx.lineWidth = 1.5
          ctx.stroke()
        }

        const img = getCarIcon({
          color,
          size: Math.round(drawSize),
          alarmed: !!vehicle.alarmed,
          sirening: !!vehicle.sirening,
          selected: isHovered,
        })
        if (img) {
          ctx.shadowColor = 'rgba(0,0,0,0.55)'
          ctx.shadowBlur = 4
          ctx.shadowOffsetX = 0
          ctx.shadowOffsetY = 2
          const drawX = vp.x - img.width / 2
          const drawY = vp.y - img.height / 2
          ctx.drawImage(img, drawX, drawY)
          ctx.shadowColor = 'transparent'
          ctx.shadowBlur = 0
          ctx.shadowOffsetX = 0
          ctx.shadowOffsetY = 0
        }

        if ((isHovered || s > 0.003) && s > 0.0008) {
          const vFontSize = Math.max(8, Math.min(11, s * 2000))
          ctx.font = `500 ${vFontSize}px ui-sans-serif, system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.fillStyle = C.vehicleLabel
          const shortName = vehicle.type || vehicle.scriptName?.split('.').pop() || t('vehicleFallback')
          ctx.fillText(shortName, vp.x, vp.y - half - 4)
        }
      }
    }

    const currentPlayers = playersRef.current
    const mRadius = Math.max(5, Math.min(16, s * 1400))

    for (const player of currentPlayers) {
      const p = playerRenderPosition(player, s, off)
      if (p.x < -50 || p.x > W + 50 || p.y < -50 || p.y > H + 50) continue

      const isHovered = hoveredPlayer === player.username
      const isSelected = selectedPlayer?.username === player.username
      const isAdmin = player.accessLevel && player.accessLevel !== '' && player.accessLevel !== 'none' && player.accessLevel !== 'user'
      const isDead = player.isAlive === false
      const isInfected = !!player.isInfected && !isDead
      const pinScale = isHovered || isSelected ? 1.2 : 1

      const r = mRadius * pinScale
      const color = getPlayerColor(player, 0.95)

      ctx.save()
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.beginPath()
      ctx.ellipse(p.x, p.y + r * 0.8, r * 0.8, r * 0.3, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      if (!prefersReducedMotion.current && !isDead) {
        const seed = player.username.charCodeAt(0) / 26
        const pulsePhase = (now / 1800 + seed) % 1
        ctx.beginPath()
        ctx.arc(p.x, p.y, r + 1 + pulsePhase * 9, 0, Math.PI * 2)
        ctx.strokeStyle = getPlayerColor(player, 0.3 * (1 - pulsePhase))
        ctx.lineWidth = 1.5
        ctx.stroke()
      }

      if (isHovered || isSelected) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, r + 4.5, 0, Math.PI * 2)
        ctx.fillStyle = getPlayerColor(player, 0.18)
        ctx.fill()
        ctx.beginPath()
        ctx.arc(p.x, p.y, r + 4.5, 0, Math.PI * 2)
        ctx.strokeStyle = getPlayerColor(player, 0.9)
        ctx.lineWidth = 1.2
        ctx.stroke()
      }

      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.5)'
      ctx.shadowBlur = 4
      ctx.shadowOffsetY = 1
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.fillStyle = C.playerRim
      ctx.fill()
      ctx.restore()

      ctx.beginPath()
      ctx.arc(p.x, p.y, r * 0.84, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()

      if (r >= 6.5) {
        ctx.save()
        ctx.fillStyle = C.playerGlyph
        ctx.beginPath()
        ctx.arc(p.x, p.y - r * 0.28, r * 0.3, 0, Math.PI * 2)
        ctx.fill()
        ctx.beginPath()
        ctx.arc(p.x, p.y + r * 0.58, r * 0.56, Math.PI, 0)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      }

      if (isInfected) {
        const wobble = prefersReducedMotion.current ? 0 : Math.sin(now / 400) * 0.6
        ctx.save()
        ctx.setLineDash([2.5, 2.5])
        ctx.beginPath()
        ctx.arc(p.x, p.y, r + 3.2 + wobble, 0, Math.PI * 2)
        ctx.strokeStyle = C.playerInfectedRing
        ctx.lineWidth = 1.4
        ctx.stroke()
        ctx.restore()
      }

      if (isDead) {
        const xLen = r * 0.44
        ctx.save()
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.lineWidth = 1.6
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(p.x - xLen, p.y - xLen)
        ctx.lineTo(p.x + xLen, p.y + xLen)
        ctx.moveTo(p.x + xLen, p.y - xLen)
        ctx.lineTo(p.x - xLen, p.y + xLen)
        ctx.stroke()
        ctx.restore()
      }

      if (isAdmin) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, r + 1.6, 0, Math.PI * 2)
        ctx.strokeStyle = C.adminStar
        ctx.lineWidth = 1.6
        ctx.stroke()
      }

      const labelY = p.y - r - 7
      const labelAlpha = isHovered || isSelected ? 1 : 0.85
      ctx.font = `600 ${Math.max(10, Math.min(13, s * 2500))}px ui-sans-serif, system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.save()
      ctx.shadowColor = C.shadowStrong
      ctx.shadowBlur = 3
      ctx.shadowOffsetY = 1
      ctx.fillStyle = hslToken('--foreground', labelAlpha)
      ctx.fillText(player.displayName || player.username, p.x, labelY)
      ctx.restore()

      if (player.health !== undefined && s > 0.0005 && !isDead) {
        const barW = 26
        const barH = 3
        const barX = p.x - barW / 2
        const barY = p.y + r + 5
        const healthPct = Math.max(0, Math.min(100, player.health)) / 100

        ctx.fillStyle = C.healthBarBg
        ctx.beginPath()
        ctx.roundRect(barX, barY, barW, barH, 1.5)
        ctx.fill()

        ctx.fillStyle =
          healthPct > 0.5 ? C.healthGood :
          healthPct > 0.25 ? C.healthWarning :
          C.healthCritical
        ctx.beginPath()
        ctx.roundRect(barX, barY, barW * healthPct, barH, 1.5)
        ctx.fill()

        ctx.strokeStyle = 'rgba(0,0,0,0.4)'
        ctx.lineWidth = 0.6
        ctx.beginPath()
        ctx.roundRect(barX, barY, barW, barH, 1.5)
        ctx.stroke()
      }
    }

    const markers = airdropMarkersRef.current
    const nowMs = Date.now()
    for (const marker of markers) {
      const age = nowMs - marker.time
      const fadeAlpha = Math.max(0, 1 - age / 300_000)
      if (fadeAlpha <= 0) continue

      const ap = playerToScreen(marker.x, marker.y, s, off)
      if (ap.x < -40 || ap.x > W + 40 || ap.y < -40 || ap.y > H + 40) continue

      const dropSize = Math.max(6, Math.min(16, s * 2000))

      if (age < 30_000 && !prefersReducedMotion.current) {
        const pulse = ((now / 800) % 1)
        const ringR = dropSize + 8 + pulse * 14
        ctx.beginPath()
        ctx.arc(ap.x, ap.y, ringR, 0, Math.PI * 2)
        ctx.strokeStyle = hslToken('--warning', 0.4 * (1 - pulse) * fadeAlpha)
        ctx.lineWidth = 2
        ctx.stroke()
      }

      ctx.save()
      ctx.globalAlpha = fadeAlpha * 0.25
      ctx.beginPath()
      ctx.ellipse(ap.x, ap.y + dropSize * 1.1, dropSize * 1.2, dropSize * 0.3, 0, 0, Math.PI * 2)
      ctx.fillStyle = C.shadowOpaque
      ctx.fill()
      ctx.restore()

      ctx.save()
      ctx.globalAlpha = fadeAlpha

      const bs = dropSize * 0.7
      const crateTop = ap.y - bs * 0.3
      const crateBottom = ap.y + bs * 1.1
      const crateH = crateBottom - crateTop

      ctx.beginPath()
      ctx.roundRect(ap.x - bs, crateTop, bs * 2, crateH, 2)
      ctx.fillStyle = C.crateBody
      ctx.fill()
      ctx.strokeStyle = C.crateBorder
      ctx.lineWidth = 1.5
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(ap.x, crateTop)
      ctx.lineTo(ap.x, crateBottom)
      ctx.moveTo(ap.x - bs, crateTop + crateH * 0.45)
      ctx.lineTo(ap.x + bs, crateTop + crateH * 0.45)
      ctx.strokeStyle = C.crateStraps
      ctx.lineWidth = 1
      ctx.stroke()

      const canopyY = crateTop - dropSize * 1.6
      const canopyW = dropSize * 1.8
      ctx.beginPath()
      ctx.moveTo(ap.x - bs, crateTop)
      ctx.lineTo(ap.x - canopyW, canopyY)
      ctx.moveTo(ap.x + bs, crateTop)
      ctx.lineTo(ap.x + canopyW, canopyY)
      ctx.moveTo(ap.x, crateTop)
      ctx.lineTo(ap.x, canopyY)
      ctx.strokeStyle = hslToken('--foreground', 0.5 * fadeAlpha)
      ctx.lineWidth = 0.8
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(ap.x - canopyW, canopyY)
      ctx.quadraticCurveTo(ap.x, canopyY - dropSize * 1.2, ap.x + canopyW, canopyY)
      ctx.strokeStyle = hslToken('--warning', 0.85 * fadeAlpha)
      ctx.lineWidth = 2.5
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(ap.x - canopyW, canopyY)
      ctx.quadraticCurveTo(ap.x, canopyY - dropSize * 1.2, ap.x + canopyW, canopyY)
      ctx.lineTo(ap.x - canopyW, canopyY)
      ctx.closePath()
      ctx.fillStyle = hslToken('--warning', 0.12 * fadeAlpha)
      ctx.fill()

      ctx.restore()

      const presetDef = AIRDROP_PRESETS.find((p) => p.id === marker.preset)
      if (presetDef && s > 0.0004) {
        ctx.save()
        const fontSize = Math.max(9, Math.min(12, s * 2200))
        ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.shadowColor = C.shadowDarker
        ctx.shadowBlur = 3
        ctx.shadowOffsetY = 1
        ctx.fillStyle = hslToken('--warning', 0.9 * fadeAlpha)
        ctx.fillText(presetLabel(presetDef.id), ap.x, ap.y - dropSize * 2.2)
        ctx.restore()
      }
    }

    if (currentPlayers.length === 0) {
      const railClearance = 72
      const rtl = isRTL(getCurrentLanguage())
      ctx.textAlign = 'center'

      ctx.fillStyle = C.emptyTitle
      ctx.font = '600 14px ui-sans-serif, system-ui, sans-serif'
      const title = t('emptyState.title')
      const titleHalfWidth = ctx.measureText(title).width / 2
      const titleX = rtl
        ? Math.min(W / 2, W - railClearance - titleHalfWidth)
        : Math.max(W / 2, railClearance + titleHalfWidth)
      ctx.fillText(title, titleX, H / 2 - 8)

      ctx.font = '400 11px ui-sans-serif, system-ui, sans-serif'
      ctx.fillStyle = C.emptySubtitle
      const subtitle = t('emptyState.subtitle')
      const subtitleHalfWidth = ctx.measureText(subtitle).width / 2
      const subtitleX = rtl
        ? Math.min(W / 2, W - railClearance - subtitleHalfWidth)
        : Math.max(W / 2, railClearance + subtitleHalfWidth)
      ctx.fillText(subtitle, subtitleX, H / 2 + 10)
    }

    if (cursorWorldPos && !isDragging) {
      const cp = playerToScreen(cursorWorldPos.x, cursorWorldPos.y, s, off)
      ctx.strokeStyle = C.crosshair
      ctx.lineWidth = 1
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(cp.x - 12, cp.y)
      ctx.lineTo(cp.x + 12, cp.y)
      ctx.moveTo(cp.x, cp.y - 12)
      ctx.lineTo(cp.x, cp.y + 12)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }, [canvasSize, loadDziTile, drawTileWithFallback, playerToScreen, playerRenderPosition, hoveredPlayer, selectedPlayer, cursorWorldPos, isDragging, showVehicles, showSafehouses, hoveredVehicle, t, presetLabel])

  useEffect(() => {
    let running = true
    const animate = () => {
      if (!running) return
      setPlayers((prev) => {
        let changed = false
        const next = prev.map((p) => {
          if (p.animProgress !== undefined && p.animProgress < 1) {
            changed = true
            return { ...p, animProgress: Math.min(1, p.animProgress + 0.06) }
          }
          return p
        })
        return changed ? next : prev
      })
      drawMap()
      animFrameRef.current = requestAnimationFrame(animate)
    }
    animate()
    return () => {
      running = false
      cancelAnimationFrame(animFrameRef.current)
      if (drawRequestRef.current) {
        cancelAnimationFrame(drawRequestRef.current)
        drawRequestRef.current = 0
      }
    }
  }, [drawMap])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          setCanvasSize({ width: Math.floor(width), height: Math.floor(height) })
        }
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  const hasInitRef = useRef(false)
  useEffect(() => {
    if (hasInitRef.current || canvasSize.width === 0) return
    hasInitRef.current = true
    const c = mapCfgRef.current.defaultCenter
    const s = mapCfgRef.current.defaultScale
    setOffset({
      x: canvasSize.width / 2 - c.x * s,
      y: canvasSize.height / 2 - c.y * s,
    })
  }, [canvasSize])

  const fitToPlayers = useCallback(() => {
    const W = canvasSize.width
    const H = canvasSize.height
    if (W === 0 || H === 0) return

    if (players.length === 0) {
      const c = mapCfgRef.current.defaultCenter
      const s = mapCfgRef.current.defaultScale
      setScale(s)
      setOffset({
        x: W / 2 - c.x * s,
        y: H / 2 - c.y * s,
      })
      return
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of players) {
      const dzi = gameTileToDzi(p.x, p.y, mapCfgRef.current)
      minX = Math.min(minX, dzi.x)
      minY = Math.min(minY, dzi.y)
      maxX = Math.max(maxX, dzi.x)
      maxY = Math.max(maxY, dzi.y)
    }

    const pad = 50000
    minX -= pad; minY -= pad; maxX += pad; maxY += pad

    const rangeX = maxX - minX
    const rangeY = maxY - minY
    const newScale = Math.min(W / rangeX, H / rangeY, MAX_SCALE)
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2

    setScale(newScale)
    setOffset({ x: W / 2 - centerX * newScale, y: H / 2 - centerY * newScale })
  }, [players, canvasSize])

  useEffect(() => {
    if (players.length > 0 && !hasFittedRef.current) {
      hasFittedRef.current = true
      fitToPlayers()
    }
  }, [players, fitToPlayers])

  useEffect(() => {
    const wrapper = mapWrapperRef.current
    if (!wrapper) return
    const canvas = canvasRef.current

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = (canvas ?? wrapper).getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15

      const prevScale = scaleRef.current
      const prevOff = offsetRef.current
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prevScale * factor))
      const ratio = newScale / prevScale
      const newOffset = {
        x: mx - (mx - prevOff.x) * ratio,
        y: my - (my - prevOff.y) * ratio,
      }

      scaleRef.current = newScale
      offsetRef.current = newOffset

      setScale(newScale)
      setOffset(newOffset)
    }

    wrapper.addEventListener('wheel', onWheel, { passive: false })
    return () => wrapper.removeEventListener('wheel', onWheel)
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) {
      pointerDownRef.current = { x: e.clientX, y: e.clientY }
      setIsDragging(true)
      setDragStart({ x: e.clientX, y: e.clientY, offX: offsetRef.current.x, offY: offsetRef.current.y })
      setContextMenu(null)
    }
  }, [])

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top

      if (isDragging) {
        setOffset({
          x: dragStart.offX + (e.clientX - dragStart.x),
          y: dragStart.offY + (e.clientY - dragStart.y),
        })
        return
      }

      const wp = screenToTile(mx, my)
      setCursorWorldPos(wp)

      let found: string | null = null
      for (const player of playersRef.current) {
        const p = playerRenderPosition(player)
        const hitR = Math.max(MARKER_HIT_RADIUS, Math.max(5, Math.min(16, scaleRef.current * 1400)) + 8)
        if (Math.hypot(mx - p.x, my - p.y) < hitR) {
          found = player.username
          break
        }
      }
      setHoveredPlayer(found)

      let foundVehicle: number | null = null
      if (showVehicles && !found) {
        const vHitRadius = Math.max(MARKER_HIT_RADIUS, Math.max(14, Math.min(36, scaleRef.current * 4200)) * 0.7)
        for (const v of vehiclesRef.current) {
          const vp = playerToScreen(v.x, v.y)
          const dist = Math.sqrt((mx - vp.x) ** 2 + (my - vp.y) ** 2)
          if (dist < vHitRadius) {
            foundVehicle = v.id
            break
          }
        }
      }
      setHoveredVehicle(foundVehicle)
    },
    [isDragging, dragStart, screenToTile, playerRenderPosition, playerToScreen, showVehicles]
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const start = pointerDownRef.current
      pointerDownRef.current = null
      if (!start) return

      const dx = Math.abs(e.clientX - start.x)
      const dy = Math.abs(e.clientY - start.y)
      setIsDragging(false)

      if (dx >= 3 || dy >= 3) return
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const clickedPlayer = playerAtScreenPoint(e.clientX - rect.left, e.clientY - rect.top)
      setSelectedPlayer(clickedPlayer)
    },
    [playerAtScreenPoint]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const wp = screenToTile(mx, my)

      let clickedPlayer: MapPlayer | undefined
      for (const player of playersRef.current) {
        const p = playerRenderPosition(player)
        const hitR = Math.max(MARKER_HIT_RADIUS, Math.max(5, Math.min(16, scaleRef.current * 1400)) + 4)
        if (Math.hypot(mx - p.x, my - p.y) < hitR) {
          clickedPlayer = player
          break
        }
      }

      let clickedVehicle: MapVehicle | undefined
      if (!clickedPlayer && showVehicles) {
        const vHitRadius = Math.max(MARKER_HIT_RADIUS, Math.max(14, Math.min(36, scaleRef.current * 4200)) * 0.7)
        for (const v of vehiclesRef.current) {
          const vp = playerToScreen(v.x, v.y)
          const dist = Math.sqrt((mx - vp.x) ** 2 + (my - vp.y) ** 2)
          if (dist < vHitRadius) {
            clickedVehicle = v
            break
          }
        }
      }

      setContextMenu({
        screenX: mx,
        screenY: my,
        worldX: wp.x,
        worldY: wp.y,
        player: clickedPlayer,
        vehicle: clickedVehicle,
      })
    },
    [screenToTile, playerRenderPosition, playerToScreen, showVehicles]
  )

  const handleMouseLeave = useCallback(() => {
    pointerDownRef.current = null
    setIsDragging(false)
    setHoveredPlayer(null)
    setHoveredVehicle(null)
    setCursorWorldPos(null)
  }, [])

  const touchRef = useRef<{ startX: number; startY: number; offX: number; offY: number; pinchDist: number | null; moved: boolean; hadPinch: boolean }>({
    startX: 0, startY: 0, offX: 0, offY: 0, pinchDist: null, moved: false, hadPinch: false,
  })

  const getTouchDist = (touches: React.TouchList) => {
    const dx = touches[0].clientX - touches[1].clientX
    const dy = touches[0].clientY - touches[1].clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const t = e.touches[0]
      touchRef.current = { startX: t.clientX, startY: t.clientY, offX: offsetRef.current.x, offY: offsetRef.current.y, pinchDist: null, moved: false, hadPinch: false }
      setIsDragging(true)
    } else if (e.touches.length === 2) {
      touchRef.current.pinchDist = getTouchDist(e.touches)
      touchRef.current.moved = true
      touchRef.current.hadPinch = true
    }
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault()
    if (e.touches.length === 2 && touchRef.current.pinchDist !== null) {
      const newDist = getTouchDist(e.touches)
      const factor = newDist / touchRef.current.pinchDist
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
      const prevScale = scaleRef.current
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prevScale * factor))
      const ratio = newScale / prevScale
      const newOffset = { x: cx - (cx - offsetRef.current.x) * ratio, y: cy - (cy - offsetRef.current.y) * ratio }
      scaleRef.current = newScale
      offsetRef.current = newOffset
      setScale(newScale)
      setOffset(newOffset)
      touchRef.current.pinchDist = newDist
    } else if (e.touches.length === 1) {
      const t = e.touches[0]
      const tr = touchRef.current
      if (Math.hypot(t.clientX - tr.startX, t.clientY - tr.startY) >= 3) tr.moved = true
      setOffset({ x: tr.offX + (t.clientX - tr.startX), y: tr.offY + (t.clientY - tr.startY) })
    }
  }, [])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    const tr = touchRef.current
    const touch = e.changedTouches[0]
    if (!tr.moved && !tr.hadPinch && touch) {
      const canvas = canvasRef.current
      if (canvas) {
        const rect = canvas.getBoundingClientRect()
        setSelectedPlayer(playerAtScreenPoint(touch.clientX - rect.left, touch.clientY - rect.top))
      }
    }
    setIsDragging(false)
    touchRef.current.pinchDist = null
  }, [playerAtScreenPoint])

  const zoomIn = useCallback(() => {
    const cx = canvasSize.width / 2
    const cy = canvasSize.height / 2
    const prev = scaleRef.current
    const next = Math.min(MAX_SCALE, prev * 1.4)
    const ratio = next / prev
    const o = offsetRef.current
    const newOffset = { x: cx - (cx - o.x) * ratio, y: cy - (cy - o.y) * ratio }
    scaleRef.current = next
    offsetRef.current = newOffset
    setScale(next)
    setOffset(newOffset)
  }, [canvasSize])
  const zoomOut = useCallback(() => {
    const cx = canvasSize.width / 2
    const cy = canvasSize.height / 2
    const prev = scaleRef.current
    const next = Math.max(MIN_SCALE, prev / 1.4)
    const ratio = next / prev
    const o = offsetRef.current
    const newOffset = { x: cx - (cx - o.x) * ratio, y: cy - (cy - o.y) * ratio }
    scaleRef.current = next
    offsetRef.current = newOffset
    setScale(next)
    setOffset(newOffset)
  }, [canvasSize])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const PAN_STEP = 40
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault()
          setOffset((prev) => ({ ...prev, y: prev.y + PAN_STEP }))
          break
        case 'ArrowDown':
          e.preventDefault()
          setOffset((prev) => ({ ...prev, y: prev.y - PAN_STEP }))
          break
        case 'ArrowLeft':
          e.preventDefault()
          setOffset((prev) => ({ ...prev, x: prev.x + PAN_STEP }))
          break
        case 'ArrowRight':
          e.preventDefault()
          setOffset((prev) => ({ ...prev, x: prev.x - PAN_STEP }))
          break
        case '+':
        case '=':
          e.preventDefault()
          zoomIn()
          break
        case '-':
          e.preventDefault()
          zoomOut()
          break
        case 'Escape':
          setContextMenu(null)
          setSelectedPlayer(null)
          break
      }
    },
    [zoomIn, zoomOut]
  )

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
        setSelectedPlayer(null)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!contextMenu) return
    const onClick = (e: MouseEvent) => {
      const menu = mapWrapperRef.current?.querySelector('[role="menu"]')
      if (menu && !menu.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', onClick, true)
    return () => document.removeEventListener('mousedown', onClick, true)
  }, [contextMenu])

  const triggerLightningAt = useCallback(
    async (x: number, y: number) => {
      if (!canWorldEvents) return
      setActionLoading('lightning')
      try {
        const res = await panelBridgeApi.triggerLightning(x, y, true, true, true)
        if (res.success) {
          toast({ title: t('toasts.lightningStrikeTitle'), description: t('toasts.lightningStrikeDesc', { x, y }) })
        }
      } catch {
        toast({ title: t('errorTitle'), description: t('toasts.lightningFailed'), variant: 'destructive' })
      } finally {
        setActionLoading(null)
        setContextMenu(null)
      }
    },
    [toast, canWorldEvents, t]
  )

  const createNoiseAt = useCallback(
    async (x: number, y: number) => {
      if (!canWorldEvents) return
      setActionLoading('noise')
      try {
        const res = await panelBridgeApi.playWorldSound(x, y, 0, 200, 100)
        if (res.success) {
          toast({ title: t('toasts.noiseCreatedTitle'), description: t('toasts.noiseCreatedDesc', { x, y }) })
        }
      } catch {
        toast({ title: t('errorTitle'), description: t('toasts.noiseFailed'), variant: 'destructive' })
      } finally {
        setActionLoading(null)
        setContextMenu(null)
      }
    },
    [toast, canWorldEvents, t]
  )

  const callAirdrop = useCallback(
    async (x: number, y: number, preset: typeof AIRDROP_PRESETS[number]['id']) => {
      if (actionLoadingRef.current) return
      if (!canRunBridgeCommand) return
      actionLoadingRef.current = 'airdrop'
      setActionLoading('airdrop')
      try {
        const res = await panelBridgeApi.triggerAirdrop({ x, y, preset, announce: true, attractZombies: true })
        if (!mountedRef.current) return
        const presetDef = AIRDROP_PRESETS.find((p) => p.id === preset)
        const label = presetDef ? presetLabel(presetDef.id) : preset
        const data = res.data as Record<string, unknown> | undefined
        const itemCount = typeof data?.itemCount === 'number' ? data.itemCount : undefined
        const failed = typeof data?.failed === 'number' ? data.failed : 0
        const coords = `${Math.round(x)}, ${Math.round(y)}`
        let desc = itemCount
          ? t('toasts.itemsDropped', { count: itemCount, coords })
          : t('toasts.supplyDrop', { coords })
        if (failed > 0) {
          desc += t('toasts.failedSuffix', { count: failed })
        }
        toast({ title: t('toasts.airdropDeployedTitle', { label }), description: desc })
        setAirdropMarkers((prev) => {
          const next = [...prev, { x, y, preset, time: Date.now() }]
          return next.length > 50 ? next.slice(-50) : next
        })
      } catch (err) {
        if (!mountedRef.current) return
        const msg = getUserErrorMessage(err, t('toasts.areaNotLoaded'))
        toast({ title: t('toasts.airdropFailedTitle'), description: msg, variant: 'destructive' })
      } finally {
        actionLoadingRef.current = null
        if (mountedRef.current) {
          setActionLoading(null)
          setContextMenu(null)
        }
      }
    },
    [toast, t, presetLabel, canRunBridgeCommand]
  )

  useEffect(() => {
    const interval = setInterval(() => {
      const cutoff = Date.now() - 300_000
      setAirdropMarkers((prev) => {
        const filtered = prev.filter((m) => m.time > cutoff)
        return filtered.length === prev.length ? prev : filtered
      })
    }, 15_000)
    return () => clearInterval(interval)
  }, [])

  const callCustomDrop = useCallback(
    async (opts: {
      x: number
      y: number
      items: Array<{ itemType: string; count: number }>
      announce: boolean
      attractZombies: boolean
      soundRadius: number
      silent?: boolean
      label?: string
    }) => {
      if (actionLoadingRef.current) return
      if (!canRunBridgeCommand) return
      const cleaned = opts.items
        .map((it) => ({
          itemType: (it.itemType || '').trim(),
          count: Math.max(1, Math.min(20, Math.floor(Number(it.count) || 1))),
        }))
        .filter((it) => it.itemType.length > 0)
      if (cleaned.length === 0) {
        toast({ title: t('toasts.noItemsTitle'), description: t('toasts.noItemsDesc'), variant: 'destructive' })
        return
      }
      const ID_RE = /^[A-Za-z]\w*\.\w+$/
      const bad = cleaned.find((it) => !ID_RE.test(it.itemType))
      if (bad) {
        toast({
          title: t('toasts.invalidItemTitle'),
          description: t('toasts.invalidItemDesc', { item: bad.itemType }),
          variant: 'destructive',
        })
        return
      }
      if (cleaned.length > 50) {
        toast({ title: t('toasts.tooManyItemsTitle'), description: t('toasts.tooManyItemsDesc'), variant: 'destructive' })
        return
      }
      actionLoadingRef.current = 'drop'
      setActionLoading('drop')
      try {
        const res = await panelBridgeApi.triggerAirdrop({
          x: opts.x,
          y: opts.y,
          items: cleaned,
          announce: opts.announce,
          attractZombies: opts.attractZombies,
          soundRadius: Math.max(10, Math.min(500, Math.floor(opts.soundRadius))),
        })
        if (!mountedRef.current) return
        const data = res.data as Record<string, unknown> | undefined
        const failed = typeof data?.failed === 'number' ? data.failed : 0
        const totalQty = cleaned.reduce((sum, it) => sum + it.count, 0)
        const coords = `${Math.round(opts.x)}, ${Math.round(opts.y)}`
        const title = opts.label ? t('toasts.droppedTitle', { label: opts.label }) : t('toasts.dropDeployed')
        let desc =
          cleaned.length === 1
            ? t('toasts.singleItemDesc', {
                item: cleaned[0].itemType.replace(/^[^.]+\./, ''),
                qtySuffix: cleaned[0].count > 1 ? t('toasts.qtySuffix', { count: cleaned[0].count }) : '',
                coords,
              })
            : t('toasts.multiItemDesc', { count: cleaned.length, total: totalQty, coords })
        if (failed > 0) desc += t('toasts.failedSuffix', { count: failed })
        if (!opts.silent) toast({ title, description: desc })
        setAirdropMarkers((prev) => {
          const next = [...prev, { x: opts.x, y: opts.y, preset: 'custom', time: Date.now() }]
          return next.length > 50 ? next.slice(-50) : next
        })
        setLastDrop({
          items: cleaned,
          label: opts.label || (cleaned.length === 1
            ? cleaned[0].itemType.replace(/^[^.]+\./, '')
            : t('toasts.itemPackageFallback', { count: cleaned.length })),
        })
      } catch (err) {
        if (!mountedRef.current) return
        const msg = getUserErrorMessage(err, t('toasts.areaNotLoaded'))
        toast({ title: t('toasts.dropFailedTitle'), description: msg, variant: 'destructive' })
      } finally {
        actionLoadingRef.current = null
        if (mountedRef.current) {
          setActionLoading(null)
        }
      }
    },
    [toast, t, canRunBridgeCommand]
  )

  const teleportPlayerTo = useCallback(
    async (username: string, x: number, y: number, z: number) => {
      if (!canRunBridgeCommand) return
      setActionLoading('teleport')
      try {
        const response = await panelBridgeApi.sendCommand('teleportPlayer', {
          username,
          x: Math.round(x),
          y: Math.round(y),
          z: Math.round(z),
        })
        if (!mountedRef.current) return
        const verifyState = getBridgeVerifiedState('teleportPlayer', response?.data)
        toast(
          verifyState === 'unverifiable'
            ? {
                title: t('toasts.teleportedTitle'),
                description: t('toasts.bridgeUnverifiedDesc', { action: t('toasts.teleportedTitle') }),
                variant: 'default',
              }
            : verifyState === 'old-bridge'
              ? {
                  title: t('toasts.teleportedTitle'),
                  description: t('toasts.bridgeOldBridgeDesc', { action: t('toasts.teleportedTitle') }),
                  variant: 'default',
                }
              : {
                  title: t('toasts.teleportedTitle'),
                  description: t('toasts.teleportedDesc', { username, x: Math.round(x), y: Math.round(y) }),
                },
        )
        fetchPlayerPositions()
      } catch (err) {
        if (!mountedRef.current) return
        const msg = getUserErrorMessage(err, t('toasts.teleportErrorFallback'))
        toast({ title: t('toasts.teleportErrorTitle'), description: msg, variant: 'destructive' })
      } finally {
        if (mountedRef.current) setActionLoading(null)
      }
    },
    [toast, fetchPlayerPositions, t, canRunBridgeCommand]
  )

  const copyCoords = useCallback(
    async (x: number, y: number) => {
      const text = `${Math.round(x)}, ${Math.round(y)}`
      const ok = await copyText(text)
      toast(ok
        ? { title: t('toasts.copiedTitle'), description: text }
        : { title: t('toasts.copyFailedTitle'), description: t('toasts.copyFailedDesc'), variant: 'destructive' })
    },
    [toast, t]
  )

  const panToPlayer = useCallback((p: MapPlayer) => {
    const W = canvasSize.width
    const H = canvasSize.height
    if (W === 0) return
    const dzi = gameTileToDzi(p.x, p.y, mapCfgRef.current)
    const viewScale = Math.max(scale, mapCfgRef.current.defaultScale * 10)
    setScale(viewScale)
    setOffset({ x: W / 2 - dzi.x * viewScale, y: H / 2 - dzi.y * viewScale })
    setSelectedPlayer(p)
  }, [canvasSize, scale])

  return (
    <div className="space-y-4 page-transition">
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        icon={<MapIcon className="w-5 h-5" />}
        actions={
          <div className="flex items-center gap-2">
            <BridgeStatusBadge connected={bridgeConnected} loading={bridgeLoading} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchPlayerPositions()}
              className="gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              {t('refresh')}
            </Button>
          </div>
        }
      />

      <div ref={mapWrapperRef} className="relative rounded-md border border-border/60 overflow-hidden bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.35)]">
        <span aria-hidden className="pointer-events-none absolute top-0 start-0 z-30 h-3 w-3 border-s-2 border-t-2 border-primary/50" />
        <span aria-hidden className="pointer-events-none absolute top-0 end-0 z-30 h-3 w-3 border-e-2 border-t-2 border-primary/50" />
        <span aria-hidden className="pointer-events-none absolute bottom-0 start-0 z-30 h-3 w-3 border-s-2 border-b-2 border-primary/50" />
        <span aria-hidden className="pointer-events-none absolute bottom-0 end-0 z-30 h-3 w-3 border-e-2 border-b-2 border-primary/50" />

        <div className="absolute top-3 start-3 z-10 w-12 rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-lg overflow-hidden">
          <div className="flex items-center justify-center gap-1 px-1.5 py-1 border-b border-border/40 bg-muted/40 font-mono text-[9px] uppercase tracking-[0.24em] text-primary/70">
            <span className="text-primary/60">//</span>
            <span>{t('controlRail.ctrlLabel')}</span>
          </div>
          <div className="flex flex-col gap-px p-1">
            <button
              onClick={zoomIn}
              aria-label={t('controlRail.zoomIn')}
              className="group h-9 w-9 rounded-sm border border-transparent hover:border-border/50 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              title={t('controlRail.zoomIn')}
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              onClick={zoomOut}
              aria-label={t('controlRail.zoomOut')}
              className="group h-9 w-9 rounded-sm border border-transparent hover:border-border/50 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              title={t('controlRail.zoomOut')}
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <button
              onClick={fitToPlayers}
              aria-label={t('controlRail.fitToPlayers')}
              className="group h-9 w-9 rounded-sm border border-transparent hover:border-border/50 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              title={t('controlRail.fitToPlayers')}
            >
              <Maximize2 className="w-4 h-4" />
            </button>
          </div>

          {mapCfg.label === 'B42' && (
            <>
              <div className="flex items-center justify-center gap-1 px-1.5 py-1 border-y border-border/40 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] text-muted-foreground/70">
                <span>{t('controlRail.floorHeader')}</span>
              </div>
              <div className="flex flex-col items-center p-1 gap-px">
                <button
                  onClick={() => changeFloor(floor + 1)}
                  disabled={floor >= 29}
                  aria-label={t('controlRail.floorUp')}
                  className="h-6 w-9 rounded-sm border border-transparent hover:border-border/50 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:border-transparent"
                  // eslint-disable-next-line local/no-dead-disabled-title -- pure hint (t('controlRail.floorUp') = "Floor up"), same text as the aria-label, unrelated to why the button disables at the floor cap. Triaged 2026-08-27, no disabled-reason text to lose.
                  title={t('controlRail.floorUp')}
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => changeFloor(0)}
                  aria-label={t('controlRail.currentFloorAria', { floor: floorLabel(floor) })}
                  className={cn(
                    'h-7 w-9 rounded-sm border flex items-center justify-center transition-colors text-[10px] font-mono font-semibold tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
                    floor !== 0
                      ? 'bg-accent/20 border-accent/40 text-accent shadow-[inset_0_0_0_1px_rgba(0,0,0,0.2)]'
                      : 'bg-muted/30 border-border/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  )}
                  title={t('controlRail.currentFloorTitle', { floor: floorLabel(floor) })}
                >
                  {floor === 0 ? <Layers className="w-3.5 h-3.5" /> : (floor > 0 ? `+${floor}` : floor)}
                </button>
                <button
                  onClick={() => changeFloor(floor - 1)}
                  disabled={floor <= -1}
                  aria-label={t('controlRail.floorDown')}
                  className="h-6 w-9 rounded-sm border border-transparent hover:border-border/50 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:border-transparent"
                  // eslint-disable-next-line local/no-dead-disabled-title -- pure hint (t('controlRail.floorDown') = "Floor down"), same text as the aria-label, unrelated to why the button disables at the floor minimum. Triaged 2026-08-27, no disabled-reason text to lose.
                  title={t('controlRail.floorDown')}
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </div>
            </>
          )}

          <div className="flex items-center justify-center gap-1 px-1.5 py-1 border-y border-border/40 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] text-muted-foreground/70">
            <span>{t('controlRail.layersHeader')}</span>
          </div>
          <div className="flex flex-col gap-px p-1">
            <button
              onClick={() => setShowVehicles((v) => !v)}
              aria-label={t(showVehicles ? 'controlRail.vehiclesHideAria' : 'controlRail.vehiclesShowAria', { count: vehicles.length })}
              aria-pressed={showVehicles}
              className={cn(
                'h-9 w-9 rounded-sm border flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
                showVehicles
                  ? 'bg-info/20 border-info/40 text-info'
                  : 'border-transparent text-muted-foreground hover:border-border/50 hover:bg-muted/60 hover:text-foreground'
              )}
              title={t(showVehicles ? 'controlRail.vehiclesHideTitle' : 'controlRail.vehiclesShowTitle', { count: vehicles.length })}
            >
              <Car className="w-4 h-4" />
            </button>
            <button
              onClick={() => setShowSafehouses((v) => !v)}
              aria-label={t(showSafehouses ? 'controlRail.safehousesHideAria' : 'controlRail.safehousesShowAria', { count: safehouses.length })}
              aria-pressed={showSafehouses}
              className={cn(
                'h-9 w-9 rounded-sm border flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
                showSafehouses
                  ? 'bg-success/20 border-success/40 text-success'
                  : 'border-transparent text-muted-foreground hover:border-border/50 hover:bg-muted/60 hover:text-foreground'
              )}
              title={t(showSafehouses ? 'controlRail.safehousesHideTitle' : 'controlRail.safehousesShowTitle', { count: safehouses.length })}
            >
              <Home className="w-4 h-4" />
            </button>
          </div>
        </div>

        {tileLoadFailing && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 max-w-md w-[min(28rem,calc(100%-7rem))]" role="alert">
            <div className="rounded-md border border-warning/60 bg-warning/15 backdrop-blur-md shadow-lg overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-3 py-1 border-b border-warning/30 bg-warning/20 font-mono text-[10px] uppercase tracking-[0.24em] text-warning">
                <span className="flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3" />
                  <span>{t('tileFailure.signalLost')}</span>
                </span>
                <span className="text-warning/70">{t('tileFailure.tilesOffline')}</span>
              </div>
              <div className="px-3 py-2 text-xs leading-snug">
                {tileByteDiagnosis ? (
                  (() => {
                    const keys = tileFailureCopyKeys(tileByteDiagnosis)
                    return (
                      <>
                        <div className="font-semibold text-foreground">{t(keys.titleKey)}</div>
                        <div className="text-muted-foreground mt-0.5">{t(keys.descKey, keys.descParams)}</div>
                      </>
                    )
                  })()
                ) : tileFailureKind === 'coverage' ? (
                  <>
                    <div className="font-semibold text-foreground">{t('tileFailure.coverageTitle')}</div>
                    <div className="text-muted-foreground mt-0.5">
                      <Trans
                        i18nKey="tileFailure.coverageDesc"
                        t={t}
                        components={{ 1: <span className="font-mono text-warning/90" /> }}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="font-semibold text-foreground">{t('tileFailure.networkTitle')}</div>
                    <div className="text-muted-foreground mt-0.5">
                      <Trans
                        i18nKey="tileFailure.networkDesc"
                        t={t}
                        components={{ 1: <span className="font-mono text-warning/90" /> }}
                      />
                    </div>
                  </>
                )}
                {tileFailureDetail && !tileByteDiagnosis && (
                  <div className="mt-1 pt-1 border-t border-warning/20 font-mono text-[10px] text-muted-foreground/70">
                    {t('tileFailure.diagnostic', { detail: tileFailureDetail })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div className={cn('absolute top-3 end-3 z-10', rosterCollapsed ? 'w-auto' : 'w-56')}>
          <div className="rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setRosterCollapsed((c) => !c)}
              aria-expanded={!rosterCollapsed}
              aria-label={rosterCollapsed ? t('roster.expandAria') : t('roster.collapseAria')}
              className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 border-b border-border/40 bg-muted/40 font-mono text-[10px] uppercase tracking-[0.22em] text-primary/70 hover:bg-muted/60 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <span className="text-primary/60">//</span>
                <span>{t('roster.label')}</span>
                <span className="text-muted-foreground/50">·</span>
                <span className={cn('flex items-center gap-1', bridgeConnected ? 'text-emerald-400/90' : 'text-muted-foreground/60')}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', bridgeConnected ? 'bg-emerald-400 animate-pulse' : 'bg-muted-foreground/40')} />
                  {bridgeConnected ? t('roster.live') : t('roster.offline')}
                </span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="text-foreground tabular-nums font-semibold">{players.length}</span>
                {rosterCollapsed ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronUp className="h-3 w-3 shrink-0" />}
              </span>
            </button>
            {!rosterCollapsed && (players.length > 0 ? (
              <div className="max-h-60 overflow-y-auto">
                {players.map((p) => (
                  <button
                    key={p.username}
                    onClick={() => panToPlayer(p)}
                    aria-label={
                      p.health !== undefined
                        ? t('roster.panToAriaWithHealth', { name: p.displayName || p.username, health: Math.round(p.health) })
                        : t('roster.panToAria', { name: p.displayName || p.username })
                    }
                    className={cn(
                      'w-full px-2.5 py-1.5 flex items-center gap-2 text-start text-xs transition-colors border-s-2 border-transparent hover:bg-muted/50',
                      selectedPlayer?.username === p.username && 'bg-muted/50 border-primary/60'
                    )}
                  >
                    <span
                      className="w-2 h-2 rounded-full flex-none ring-1 ring-black/30"
                      style={{ backgroundColor: getPlayerColor(p, 0.9) }}
                    />
                    <span className="truncate flex-1">{p.displayName || p.username}</span>
                    {p.health !== undefined && (
                      <span className={cn(
                        'text-[10px] font-mono tabular-nums',
                        p.health > 50 ? 'text-emerald-400' : p.health > 25 ? 'text-amber-400' : 'text-destructive'
                      )}>
                        {Math.round(p.health)}%
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-3 py-3 flex items-center gap-2 text-[11px] font-mono text-muted-foreground/70">
                <span className={cn('h-1.5 w-1.5 rounded-full', bridgeConnected ? 'bg-muted-foreground/40' : 'bg-destructive/70')} />
                <span>
                  {loading ? t('roster.loading') : bridgeConnected ? t('roster.noPlayersOnline') : t('roster.bridgeOffline')}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="absolute bottom-3 start-3 z-10">
          <div className="flex items-stretch rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-lg font-mono text-[11px] tabular-nums overflow-hidden">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-e border-border/40">
              <Crosshair className={cn('w-3 h-3', cursorWorldPos ? 'text-primary/80' : 'text-muted-foreground/40')} />
              {cursorWorldPos ? (
                <span className="text-foreground">
                  <span className="text-muted-foreground/60">x</span>{cursorWorldPos.x.toString().padStart(5, ' ')}<span className="mx-1 text-muted-foreground/40">·</span><span className="text-muted-foreground/60">y</span>{cursorWorldPos.y.toString().padStart(5, ' ')}
                </span>
              ) : (
                <span className="text-muted-foreground/50">{t('hud.hoverForCoords')}</span>
              )}
            </div>
            <div className="flex items-center gap-1 px-2.5 py-1.5 border-e border-border/40">
              <span className="text-muted-foreground/50 text-[9px] uppercase tracking-[0.22em]">z</span>
              <span className={cn(floor !== 0 ? 'text-accent' : 'text-muted-foreground/70')}>{floorLabel(floor)}</span>
            </div>
            <div className="flex items-center gap-1 px-2.5 py-1.5">
              <span className="text-muted-foreground/50 text-[9px] uppercase tracking-[0.22em]">zm</span>
              <span className="text-muted-foreground/80">{(scale / mapCfg.defaultScale * 100).toFixed(0)}%</span>
            </div>
          </div>
        </div>

        {selectedPlayer && (
          <div className="absolute end-3 z-10 w-60 bottom-14 sm:bottom-3">
            <div className="relative rounded-md border border-border/55 bg-card/90 backdrop-blur-md shadow-lg overflow-hidden">
              <span aria-hidden className="pointer-events-none absolute top-0 start-0 h-2 w-2 border-s-2 border-t-2 border-primary/50" />
              <span aria-hidden className="pointer-events-none absolute top-0 end-0 h-2 w-2 border-e-2 border-t-2 border-primary/50" />
              <span aria-hidden className="pointer-events-none absolute bottom-0 start-0 h-2 w-2 border-s-2 border-b-2 border-primary/50" />
              <span aria-hidden className="pointer-events-none absolute bottom-0 end-0 h-2 w-2 border-e-2 border-b-2 border-primary/50" />
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-border/40 bg-muted/40 font-mono text-[10px] uppercase tracking-[0.22em] text-primary/70">
                <span className="flex items-center gap-1.5">
                  <span className="text-primary/60">//</span>
                  <span>{t('dossier.label')}</span>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="text-emerald-400/90">{t('dossier.targetAcquired')}</span>
                </span>
                <button
                  onClick={() => setSelectedPlayer(null)}
                  className="p-0.5 -m-0.5 rounded text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 transition-colors"
                  aria-label={t('dossier.closeAria')}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="px-3 pt-2.5 pb-2 border-b border-border/30">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full ring-1 ring-black/30 flex-none"
                    style={{ backgroundColor: getPlayerColor(selectedPlayer, 0.9) }}
                  />
                  <span className="text-sm font-semibold truncate">
                    {selectedPlayer.displayName || selectedPlayer.username}
                  </span>
                </div>
              </div>
              <div className="px-3 py-2 text-xs space-y-1.5">
                <div className="flex justify-between items-baseline">
                  <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{t('dossier.pos')}</span>
                  <span className="font-mono tabular-nums">{Math.round(selectedPlayer.x)}, {Math.round(selectedPlayer.y)}</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{t('dossier.floor')}</span>
                  <span className="font-mono tabular-nums">{selectedPlayer.z}</span>
                </div>
                {selectedPlayer.health !== undefined && (
                  <div className="flex justify-between items-center">
                    <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{t('dossier.hp')}</span>
                    <div className="flex items-center gap-1.5">
                      <div className="w-16 h-1.5 rounded-sm bg-muted/60 overflow-hidden ring-1 ring-black/20">
                        <div
                          className="h-full transition-all"
                          style={{
                            width: `${Math.max(0, Math.min(100, selectedPlayer.health))}%`,
                            backgroundColor:
                              selectedPlayer.health > 50 ? 'hsl(var(--success))'
                              : selectedPlayer.health > 25 ? 'hsl(var(--warning))'
                              : 'hsl(var(--destructive))',
                          }}
                        />
                      </div>
                      <span className="font-mono tabular-nums w-8 text-end">{Math.round(selectedPlayer.health)}%</span>
                    </div>
                  </div>
                )}
                {([
                  { key: 'hunger', value: selectedPlayer.hunger, label: t('dossier.hunger') },
                  { key: 'thirst', value: selectedPlayer.thirst, label: t('dossier.thirst') },
                  { key: 'fatigue', value: selectedPlayer.fatigue, label: t('dossier.fatigue') },
                ] as const).map(({ key, value, label }) => value === undefined ? null : (
                  <div key={key} className="flex justify-between items-center">
                    <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{label}</span>
                    <div className="flex items-center gap-1.5">
                      <div className="w-16 h-1.5 rounded-sm bg-muted/60 overflow-hidden ring-1 ring-black/20">
                        <div
                          className="h-full transition-all"
                          style={{
                            width: `${Math.max(0, Math.min(100, value * 100))}%`,
                            backgroundColor:
                              value < 0.5 ? 'hsl(var(--success))'
                              : value < 0.75 ? 'hsl(var(--warning))'
                              : 'hsl(var(--destructive))',
                          }}
                        />
                      </div>
                      <span className="font-mono tabular-nums w-8 text-end">{Math.round(value * 100)}%</span>
                    </div>
                  </div>
                ))}
                {selectedPlayer.accessLevel && selectedPlayer.accessLevel !== 'none' && selectedPlayer.accessLevel !== 'user' && selectedPlayer.accessLevel !== '' && (
                  <div className="flex justify-between items-baseline">
                    <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{t('dossier.role')}</span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-400">{selectedPlayer.accessLevel}</span>
                  </div>
                )}
                {selectedPlayer.isInfected && (
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{t('dossier.status')}</span>
                    <span className="flex items-center gap-1 text-destructive font-mono text-[10px] uppercase tracking-[0.18em]">
                      <Skull className="w-3 h-3" />
                      <span>{t('dossier.infected')}</span>
                    </span>
                  </div>
                )}
              </div>
              <div className="space-y-1 border-t border-border/40 bg-muted/20 px-2 py-1.5">
                <div className="grid grid-cols-2 gap-1">
                <DisabledReason reason={!canGmTools ? t('permissions.noGmToolsBridgeAction') : null}>
                  <Button
                    size="sm" variant="ghost" className="h-7 min-w-0 w-full px-1.5 text-xs gap-1"
                    disabled={actionLoading !== null || !canGmTools}
                    onClick={() => {
                      if (!canGmTools) return
                      setActionLoading('heal-card')
                      panelBridgeApi.sendCommand('healPlayer', { username: selectedPlayer.username })
                        .then(() => { toast({ title: t('dossier.healedTitle'), description: t('dossier.healedDesc', { username: selectedPlayer.username }) }); fetchPlayerPositions() })
                        .catch(() => toast({ title: t('errorTitle'), variant: 'destructive' }))
                        .finally(() => setActionLoading(null))
                    }}
                  >
                    <Heart className="w-3 h-3" /> {t('dossier.heal')}
                  </Button>
                </DisabledReason>
                <div className="flex min-w-0 items-center gap-1">
                  <DisabledReason reason={!canGmTools ? t('permissions.noGmToolsBridgeAction') : null} className="min-w-0 flex-1">
                    <Button
                      size="sm" variant="ghost" className="h-7 min-w-0 w-full px-1.5 text-xs gap-1"
                      disabled={actionLoading !== null || !canGmTools}
                      onClick={() => {
                        if (!canGmTools) return
                        setActionLoading('god-card')
                        panelBridgeApi.sendCommand('setGodMode', { username: selectedPlayer.username, enabled: true })
                          .then((response) => {
                            const state = getBridgeVerifiedState('setGodMode', response?.data)
                            if (state === 'unverifiable') {
                              toast({ title: t('dossier.godModeEnabled'), description: t('toasts.bridgeUnverifiedDesc', { action: t('dossier.god') }), variant: 'default' })
                            } else if (state === 'old-bridge') {
                              toast({ title: t('dossier.godModeEnabled'), description: t('toasts.bridgeOldBridgeDesc', { action: t('dossier.god') }), variant: 'default' })
                            } else {
                              toast({ title: t('dossier.godModeEnabled') })
                            }
                          })
                          .catch(() => toast({ title: t('errorTitle'), variant: 'destructive' }))
                          .finally(() => setActionLoading(null))
                      }}
                    >
                      <Shield className="w-3 h-3" /> {t('dossier.god')}
                    </Button>
                  </DisabledReason>
                  <HelpTip label={t('dossier.god')} className="shrink-0">{t('dossier.godTip')}</HelpTip>
                </div>
                </div>
                <Link
                  to="/players"
                  search={{ player: selectedPlayer.username }}
                  onClick={() => setSelectedPlayer(null)}
                  className="flex min-h-7 items-center justify-center gap-1.5 rounded-sm border border-border/50 px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                >
                  <Users className="h-3 w-3" />
                  <span>{t('dossier.openPlayerControls')}</span>
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            </div>
          </div>
        )}

        {contextMenu && (
          <div
            ref={(el) => {
              if (el) {
                const first = el.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
                first?.focus()
              }
            }}
            role="menu"
            aria-label={t('contextMenu.ariaLabel')}
            className="absolute z-20 min-w-[220px] sm:min-w-[260px] rounded-md bg-card/95 backdrop-blur-md border border-border/55 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.6)] ring-1 ring-primary/10 overflow-y-auto overscroll-contain"
            style={{
              left: contextMenu.screenX,
              top: contextMenu.screenY,
              transform: [
                contextMenu.screenX > (canvasSize.width || 800) / 2 ? 'translateX(-100%)' : '',
                contextMenu.screenY > (canvasSize.height || 600) / 2 ? 'translateY(-100%)' : '',
              ].filter(Boolean).join(' ') || undefined,
              maxHeight: Math.max(
                160,
                (contextMenu.screenY > (canvasSize.height || 600) / 2
                  ? contextMenu.screenY
                  : (canvasSize.height || 600) - contextMenu.screenY) - 12,
              ),
              animation: 'popoverEnter 0.15s ease-out',
            }}
            onKeyDown={(e) => {
              const items = e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
              const focused = document.activeElement as HTMLElement
              const idx = Array.from(items).indexOf(focused as HTMLButtonElement)
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                items[(idx + 1) % items.length]?.focus()
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                items[(idx - 1 + items.length) % items.length]?.focus()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setContextMenu(null)
              }
            }}
          >
            <div className="flex items-center justify-between gap-1 px-2 py-1.5 text-[10px] font-mono uppercase tracking-[0.2em] text-primary/70 border-b border-border/40 select-none bg-muted/30">
              <span className="flex items-center gap-1.5">
                <span className="text-primary/60">//</span>
                <span>{t('contextMenu.actionsLabel')}</span>
                <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                <span className="text-foreground tabular-nums normal-case tracking-normal">{Math.round(contextMenu.worldX)}, {Math.round(contextMenu.worldY)}</span>
                <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                <span className="text-muted-foreground/60 normal-case tracking-normal">{floorLabel(floor)}</span>
              </span>
              <button
                type="button"
                title={t('contextMenu.copyCoordsTitle')}
                aria-label={t('contextMenu.copyCoordsTitle')}
                className="p-1 -m-1 rounded hover:bg-muted/60 text-muted-foreground/60 hover:text-foreground transition-colors"
                onClick={(ev) => {
                  ev.stopPropagation()
                  copyCoords(contextMenu.worldX, contextMenu.worldY)
                }}
              >
                <Copy className="w-3 h-3" />
              </button>
            </div>

            {contextMenu.player && (
              <>
                <div className="px-2.5 pt-2 pb-1.5 border-b border-border/30 select-none">
                  <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.24em] text-primary/60 mb-1">
                    <span>›</span>
                    <span>{t('contextMenu.targetLabel')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-full ring-1 ring-black/30 flex-none"
                      style={{ backgroundColor: getPlayerColor(contextMenu.player, 0.9) }}
                    />
                    <strong className="text-foreground text-xs truncate">{contextMenu.player.username}</strong>
                  </div>
                </div>
                <ContextMenuItem
                  icon={<Heart className="w-3.5 h-3.5 text-emerald-400" />}
                  label={t('contextMenu.healPlayer')}
                  description={!canGmTools ? t('permissions.noGmToolsBridgeAction') : undefined}
                  tone="success"
                  disabled={!canGmTools}
                  onClick={() => {
                    if (!canGmTools) return
                    panelBridgeApi.sendCommand('healPlayer', { username: contextMenu.player!.username })
                      .then(() => { toast({ title: t('dossier.healedTitle'), description: t('dossier.healedDesc', { username: contextMenu.player!.username }) }); fetchPlayerPositions() })
                      .catch(() => toast({ title: t('errorTitle'), variant: 'destructive' }))
                    setContextMenu(null)
                  }}
                />
              </>
            )}

            {contextMenu.vehicle && (
              <>
                <div className="px-2.5 pt-2 pb-2 border-b border-border/30 select-none">
                  <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.24em] text-info/70 mb-1.5">
                    <span>›</span>
                    <Car className="w-2.5 h-2.5" />
                    <span>{t('contextMenu.vehicleLabel')}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs">
                    <strong className="text-foreground truncate">{contextMenu.vehicle.type || contextMenu.vehicle.scriptName?.split('.').pop() || t('vehicleFallback')}</strong>
                  </div>
                  <div className="mt-1.5 space-y-1">
                    {contextMenu.vehicle.fuelPct != null && (
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground/70 w-9">{t('contextMenu.fuel')}</span>
                        <div className="flex-1 h-1.5 rounded-sm bg-muted/60 overflow-hidden ring-1 ring-black/20">
                          <div
                            className={cn("h-full transition-all", contextMenu.vehicle.fuelPct > 30 ? "bg-info/80" : contextMenu.vehicle.fuelPct > 10 ? "bg-amber-400/80" : "bg-destructive/80")}
                            style={{ width: `${Math.round(contextMenu.vehicle.fuelPct)}%` }}
                          />
                        </div>
                        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/80 w-8 text-end">{Math.round(contextMenu.vehicle.fuelPct)}%</span>
                      </div>
                    )}
                    {contextMenu.vehicle.batteryCharge != null && (
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground/70 w-9">{t('contextMenu.batt')}</span>
                        <div className="flex-1 h-1.5 rounded-sm bg-muted/60 overflow-hidden ring-1 ring-black/20">
                          <div
                            className={cn("h-full transition-all", contextMenu.vehicle.batteryCharge > 30 ? "bg-info/80" : contextMenu.vehicle.batteryCharge > 10 ? "bg-amber-400/80" : "bg-destructive/80")}
                            style={{ width: `${Math.round(contextMenu.vehicle.batteryCharge)}%` }}
                          />
                        </div>
                        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/80 w-8 text-end">{Math.round(contextMenu.vehicle.batteryCharge)}%</span>
                      </div>
                    )}
                    {contextMenu.vehicle.fuelPct == null && contextMenu.vehicle.batteryCharge == null && (
                      <div className="font-mono text-[10px] text-muted-foreground/50 italic">{t('contextMenu.noTelemetry')}</div>
                    )}
                  </div>
                </div>
                {contextMenu.vehicle.persisted ? (
                  <div className="px-2.5 py-2 text-[11px] text-muted-foreground/70 border-t border-border/30">
                    {t('contextMenu.loadAreaFirst')}
                  </div>
                ) : (
                  <>
                    <ContextMenuItem
                      icon={<Wrench className="w-3.5 h-3.5 text-info" />}
                      label={t('contextMenu.repairVehicle')}
                      description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : undefined}
                      tone="info"
                      loading={actionLoading === 'vehicle-repair'}
                      disabled={!canRunBridgeCommand}
                      onClick={() => {
                    if (!canRunBridgeCommand) return
                    setActionLoading('vehicle-repair')
                    panelBridgeApi.sendCommand('vehicleRepair', { vehicleId: contextMenu.vehicle!.id })
                      .then(() => {
                        toast({ title: t('toasts.vehicleRepaired') })
                        fetchOverlays()
                      })
                      .catch((err) => toast({ title: t('toasts.repairFailed'), description: getUserErrorMessage(err, t('toasts.unknownError')), variant: 'destructive' }))
                      .finally(() => { setActionLoading(null); setContextMenu(null) })
                      }}
                    />
                    <ContextMenuItem
                  icon={<Fuel className="w-3.5 h-3.5 text-info" />}
                  label={t('contextMenu.fillFuel')}
                  description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : undefined}
                  tone="info"
                  loading={actionLoading === 'vehicle-fuel'}
                  disabled={!canRunBridgeCommand}
                  onClick={() => {
                    if (!canRunBridgeCommand) return
                    setActionLoading('vehicle-fuel')
                    panelBridgeApi.sendCommand('vehicleSetFuel', { vehicleId: contextMenu.vehicle!.id, percent: 100 })
                      .then((response) => {
                        const state = getBridgeVerifiedState('vehicleSetFuel', response?.data)
                        if (state === 'unverifiable') {
                          toast({ title: t('toasts.fuelFilled'), description: t('toasts.bridgeUnverifiedDesc', { action: t('toasts.fuelFilled') }), variant: 'default' })
                        } else if (state === 'old-bridge') {
                          toast({ title: t('toasts.fuelFilled'), description: t('toasts.bridgeOldBridgeDesc', { action: t('toasts.fuelFilled') }), variant: 'default' })
                        } else {
                          toast({ title: t('toasts.fuelFilled') })
                        }
                        fetchOverlays()
                      })
                      .catch((err) => toast({ title: t('toasts.fuelFailed'), description: getUserErrorMessage(err, t('toasts.unknownError')), variant: 'destructive' }))
                      .finally(() => { setActionLoading(null); setContextMenu(null) })
                      }}
                    />
                    <ContextMenuItem
                  icon={<Battery className="w-3.5 h-3.5 text-info" />}
                  label={t('contextMenu.chargeBattery')}
                  description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : undefined}
                  tone="info"
                  loading={actionLoading === 'vehicle-battery'}
                  disabled={!canRunBridgeCommand}
                  onClick={() => {
                    if (!canRunBridgeCommand) return
                    setActionLoading('vehicle-battery')
                    panelBridgeApi.sendCommand('vehicleSetBattery', { vehicleId: contextMenu.vehicle!.id, charge: 100 })
                      .then((response) => {
                        const state = getBridgeVerifiedState('vehicleSetBattery', response?.data)
                        if (state === 'unverifiable') {
                          toast({ title: t('toasts.batteryCharged'), description: t('toasts.bridgeUnverifiedDesc', { action: t('toasts.batteryCharged') }), variant: 'default' })
                        } else if (state === 'old-bridge') {
                          toast({ title: t('toasts.batteryCharged'), description: t('toasts.bridgeOldBridgeDesc', { action: t('toasts.batteryCharged') }), variant: 'default' })
                        } else {
                          toast({ title: t('toasts.batteryCharged') })
                        }
                        fetchOverlays()
                      })
                      .catch((err) => toast({ title: t('toasts.batteryFailed'), description: getUserErrorMessage(err, t('toasts.unknownError')), variant: 'destructive' }))
                      .finally(() => { setActionLoading(null); setContextMenu(null) })
                      }}
                    />
                    <ContextMenuItem
                  icon={<Trash2 className="w-3.5 h-3.5 text-destructive" />}
                  label={t('contextMenu.removeVehicle')}
                  description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : undefined}
                  tone="danger"
                  disabled={!canRunBridgeCommand}
                  onClick={() => {
                    const v = contextMenu.vehicle!
                    setRemoveVehicleTarget({
                      id: v.id,
                      label: v.type || v.scriptName?.split('.').pop() || t('vehicleFallback'),
                      x: Math.round(v.x),
                      y: Math.round(v.y),
                    })
                    setContextMenu(null)
                      }}
                    />
                    <ContextMenuItem
                  icon={<Zap className="w-3.5 h-3.5 text-amber-400" />}
                  label={t('contextMenu.hotwire')}
                  description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : undefined}
                  tone="warning"
                  loading={actionLoading === 'vehicle-hotwire'}
                  disabled={!canRunBridgeCommand}
                  onClick={() => {
                    if (!canRunBridgeCommand) return
                    setActionLoading('vehicle-hotwire')
                    panelBridgeApi.sendCommand('vehicleHotwire', { vehicleId: contextMenu.vehicle!.id })
                      .then(() => {
                        toast({ title: t('toasts.vehicleHotwired'), description: t('toasts.engineStarted') })
                      })
                      .catch((err) => toast({ title: t('toasts.hotwireFailed'), description: getUserErrorMessage(err, t('toasts.unknownError')), variant: 'destructive' }))
                      .finally(() => { setActionLoading(null); setContextMenu(null) })
                      }}
                    />
                  </>
                )}
              </>
            )}

            {playersRef.current.length > 0 && (
              <div className="border-t border-border/30">
                <ContextMenuSection label={t('contextMenu.teleportLabel')} icon={<Locate className="w-2.5 h-2.5" />} tone="primary" />
                {playersRef.current.slice(0, 6).map((pl) => {
                  const pColor = pl.isInfected
                    ? 'text-destructive'
                    : pl.accessLevel && pl.accessLevel !== '' && pl.accessLevel !== 'none' && pl.accessLevel !== 'user'
                      ? 'text-amber-400'
                      : 'text-info'
                  return (
                    <ContextMenuItem
                      key={`tp-${pl.username}`}
                      icon={<Users className={cn('w-3.5 h-3.5', pColor)} />}
                      label={pl.displayName || pl.username}
                      description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : t('contextMenu.teleportDesc', {
                        fromX: Math.round(pl.x),
                        fromY: Math.round(pl.y),
                        toX: Math.round(contextMenu.worldX),
                        toY: Math.round(contextMenu.worldY),
                      })}
                      tone="primary"
                      loading={actionLoading === 'teleport'}
                      disabled={!bridgeConnected || !canRunBridgeCommand}
                      onClick={() => {
                        teleportPlayerTo(pl.username, contextMenu.worldX, contextMenu.worldY, floor)
                        setContextMenu(null)
                      }}
                    />
                  )
                })}
                {playersRef.current.length > 6 && (
                  <div className="px-2.5 py-1 font-mono text-[10px] text-muted-foreground/50 italic select-none">
                    {t('contextMenu.moreOnline', { count: playersRef.current.length - 6 })}
                  </div>
                )}
              </div>
            )}

            <div className="border-t border-border/30">
              <ContextMenuSection label={t('contextMenu.effectsLabel')} icon={<Zap className="w-2.5 h-2.5" />} tone="info" />
              <ContextMenuItem
                icon={<CloudLightning className="w-3.5 h-3.5 text-info" />}
                label={t('contextMenu.lightningStrike')}
                description={!canWorldEvents ? t('permissions.noWorldEvents') : t('contextMenu.lightningDesc')}
                tone="info"
                loading={actionLoading === 'lightning'}
                disabled={!canWorldEvents}
                onClick={() => triggerLightningAt(contextMenu.worldX, contextMenu.worldY)}
              />
              <ContextMenuItem
                icon={<Volume2 className="w-3.5 h-3.5 text-amber-400" />}
                label={t('contextMenu.createNoise')}
                description={!canWorldEvents ? t('permissions.noWorldEvents') : t('contextMenu.createNoiseDesc')}
                tone="warning"
                loading={actionLoading === 'noise'}
                disabled={!canWorldEvents}
                onClick={() => createNoiseAt(contextMenu.worldX, contextMenu.worldY)}
              />
              <ContextMenuItem
                icon={<Car className="w-3.5 h-3.5 text-muted-foreground" />}
                label={t('contextMenu.spawnVehicleHere')}
                description={!canGmTools ? t('permissions.noGmTools') : t('contextMenu.spawnVehicleDesc')}
                disabled={!bridgeConnected || !canGmTools}
                onClick={() => {
                  setSpawnDialog({ x: Math.round(contextMenu.worldX), y: Math.round(contextMenu.worldY), z: floor })
                  setSpawnVehicleId('')
                  setContextMenu(null)
                }}
              />
            </div>

            <div className="border-t border-border/30">
              <ContextMenuSection label={t('contextMenu.dropsLabel')} icon={<Package className="w-2.5 h-2.5" />} tone="warning" />
              <ContextMenuItem
                icon={<Package className="w-3.5 h-3.5 text-amber-400" />}
                label={t('contextMenu.customDrop')}
                description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : t('contextMenu.customDropDesc')}
                tone="warning"
                disabled={!bridgeConnected || !canRunBridgeCommand}
                onClick={() => {
                  setDropDialog({ x: Math.round(contextMenu.worldX), y: Math.round(contextMenu.worldY), z: floor })
                  if (lastDrop && lastDrop.items.length > 0) {
                    setDropItems(lastDrop.items.map((it) => ({ ...it })))
                  } else {
                    setDropItems([{ itemType: '', count: 1 }])
                  }
                  setActiveTemplateId(null)
                  setSavingTemplate(false)
                  setTemplateNameInput('')
                  setDropAnnounce(true)
                  setDropAttractZombies(true)
                  setDropSoundRadius(150)
                  setContextMenu(null)
                }}
              />
              {lastDrop && (
                <ContextMenuItem
                  icon={<RefreshCw className="w-3.5 h-3.5 text-amber-400/80" />}
                  label={t('contextMenu.repeatLastDrop')}
                  description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : lastDrop.label}
                  tone="warning"
                  loading={actionLoading === 'drop'}
                  disabled={!bridgeConnected || !canRunBridgeCommand}
                  onClick={() => {
                    callCustomDrop({
                      x: contextMenu.worldX,
                      y: contextMenu.worldY,
                      items: lastDrop.items,
                      announce: false, // repeats are silent in-world
                      attractZombies: true,
                      soundRadius: 150,
                      label: lastDrop.label,
                    })
                    setContextMenu(null)
                  }}
                />
              )}
              {dropTemplates.length > 0 && (
                <>
                  <ContextMenuSection label={t('contextMenu.savedPackages')} icon={<Save className="w-2.5 h-2.5" />} tone="muted" />
                  {dropTemplates.slice(0, 8).map((tpl) => (
                    <ContextMenuItem
                      key={tpl.id}
                      icon={<Package className="w-3.5 h-3.5 text-amber-400/70" />}
                      label={tpl.name}
                      description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : t('dropDialog.templateItemCount', { count: tpl.items.length })}
                      tone="warning"
                      loading={actionLoading === 'drop'}
                      disabled={!bridgeConnected || !canRunBridgeCommand}
                      onClick={() => {
                        callCustomDrop({
                          x: contextMenu.worldX,
                          y: contextMenu.worldY,
                          items: tpl.items,
                          announce: true,
                          attractZombies: true,
                          soundRadius: 150,
                          label: tpl.name,
                        })
                        setContextMenu(null)
                      }}
                    />
                  ))}
                </>
              )}
              <ContextMenuSection label={t('contextMenu.presetCrates')} icon={<Package className="w-2.5 h-2.5" />} tone="muted" />
              {AIRDROP_PRESETS.map((preset) => (
                <ContextMenuItem
                  key={preset.id}
                  icon={<preset.icon className="w-3.5 h-3.5 text-amber-400/80" />}
                  label={presetLabel(preset.id)}
                  description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : presetDesc(preset.id)}
                  tone="warning"
                  loading={actionLoading === 'airdrop'}
                  disabled={!bridgeConnected || !canRunBridgeCommand}
                  onClick={() => callAirdrop(contextMenu.worldX, contextMenu.worldY, preset.id)}
                />
              ))}
              {!bridgeConnected && (
                <div className="mt-1 mx-2 mb-1.5 px-2 py-1.5 rounded-sm border border-destructive/30 bg-destructive/10 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-destructive/85">
                  <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
                  <span>{t('contextMenu.bridgeOfflineDrops')}</span>
                </div>
              )}
            </div>
          </div>
        )}

        <div
          ref={containerRef}
          className="w-full"
          style={{ height: 'calc(100vh - 180px)', minHeight: '500px' }}
        >
          <canvas
            ref={canvasRef}
            tabIndex={0}
            role="img"
            aria-label={t('canvasAria')}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onContextMenu={handleContextMenu}
            onKeyDown={handleKeyDown}
            className={cn('block w-full h-full outline-none focus-visible:ring-2 focus-visible:ring-primary/50', isDragging ? 'cursor-grabbing' : (hoveredPlayer || hoveredVehicle) ? 'cursor-pointer' : 'cursor-grab')}
          />
        </div>
      </div>

      <Dialog open={!!spawnDialog} onOpenChange={(open) => { if (!open) setSpawnDialog(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Car className="w-5 h-5" />
              {t('spawnDialog.title')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground font-mono tabular-nums">
                {t('spawnDialog.location', { x: spawnDialog?.x, y: spawnDialog?.y, z: spawnDialog?.z ?? 0 })}
              </span>
              <HelpTip label={t('spawnDialog.title')}>{t('spawnDialog.floorTip')}</HelpTip>
            </div>
            <VehiclePicker
              value={spawnVehicleId}
              onChange={setSpawnVehicleId}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSpawnDialog(null)}>{t('spawnDialog.cancel')}</Button>
            <DisabledReason reason={!canGmTools ? t('permissions.noGmTools') : null}>
            <Button
              disabled={!spawnVehicleId || actionLoading === 'spawn-vehicle' || !canGmTools}
              onClick={() => {
                if (!spawnDialog || !spawnVehicleId) return
                if (!canGmTools) return
                setActionLoading('spawn-vehicle')
                playersApi.addVehicleAt(
                  spawnVehicleId,
                  spawnDialog.x,
                  spawnDialog.y,
                  spawnDialog.z,
                )
                  .then(() => {
                    toast({ title: t('toasts.vehicleSpawnedTitle'), description: t('toasts.vehicleSpawnedDesc', { vehicle: spawnVehicleId.split('.').pop(), x: spawnDialog.x, y: spawnDialog.y }) })
                    fetchOverlays()
                    setSpawnDialog(null)
                  })
                  .catch((err) => toast({ title: t('toasts.spawnFailedTitle'), description: getUserErrorMessage(err, t('toasts.unknownError')), variant: 'destructive' }))
                  .finally(() => setActionLoading(null))
              }}
            >
              {actionLoading === 'spawn-vehicle' ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : <Plus className="w-4 h-4 me-2" />}
              {t('spawnDialog.spawn')}
            </Button>
            </DisabledReason>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!dropDialog} onOpenChange={(open) => { if (!open) setDropDialog(null) }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="w-5 h-5 text-warning" />
              {t('dropDialog.title')}
              {activeTemplateId && (() => {
                const tpl = dropTemplates.find((t) => t.id === activeTemplateId)
                return tpl ? (
                  <span className="ms-1 inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-normal text-muted-foreground">
                    <Save className="w-3 h-3" />
                    {tpl.name}
                  </span>
                ) : null
              })()}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs font-mono tabular-nums">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Crosshair className="w-3.5 h-3.5" />
                <span className="text-foreground">{dropDialog?.x}, {dropDialog?.y}</span>
                <span className="text-muted-foreground/50">·</span>
                <span>{floorLabel(dropDialog?.z ?? 0)}</span>
              </div>
              <button
                type="button"
                className="text-muted-foreground/60 hover:text-foreground"
                title={t('dropDialog.copyCoordsTitle')}
                onClick={() => dropDialog && copyCoords(dropDialog.x, dropDialog.y)}
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <Label className="text-xs text-muted-foreground flex items-center gap-1.5 me-auto">
                <Save className="w-3.5 h-3.5" />
                {t('dropDialog.packageTemplates')}
              </Label>
              {dropTemplates.length > 0 ? (
                <>
                  <select
                    value={activeTemplateId ?? ''}
                    onChange={(e) => {
                      const id = e.target.value
                      if (!id) {
                        setActiveTemplateId(null)
                        return
                      }
                      const tpl = dropTemplates.find((t) => t.id === id)
                      if (tpl) {
                        setDropItems(tpl.items.map((it) => ({ ...it })))
                        setActiveTemplateId(tpl.id)
                      }
                    }}
                    className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs min-w-[140px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">{t('dropDialog.loadPackagePlaceholder')}</option>
                    {dropTemplates.map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {t('dropDialog.templateOptionLabel', { name: tpl.name, count: tpl.items.length })}
                      </option>
                    ))}
                  </select>
                  {activeTemplateId && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 text-destructive hover:text-destructive"
                      title={t('dropDialog.deletePackageTitle')}
                      onClick={() => setDeleteTemplateId(activeTemplateId)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </>
              ) : (
                <span className="text-[11px] text-muted-foreground/60 italic">{t('dropDialog.noPackagesYet')}</span>
              )}
            </div>

            <div className="rounded-md border border-border/50 bg-muted/10 divide-y divide-border/30">
              {dropItems.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground/60 italic">
                  {t('dropDialog.noItemsRow')}
                </div>
              )}
              {dropItems.map((item, idx) => (
                <div key={idx} className="flex items-end gap-2 px-2 py-2">
                  <div className="flex-1 min-w-0">
                    {idx === 0 && (
                      <Label className="text-[10px] text-muted-foreground/70 mb-1 block">{t('dropDialog.itemLabel')}</Label>
                    )}
                    <ItemPicker
                      value={item.itemType}
                      onChange={(val) => {
                        setDropItems((prev) => prev.map((it, i) => (i === idx ? { ...it, itemType: val } : it)))
                        setActiveTemplateId(null)
                      }}
                      placeholder={t('dropDialog.itemPlaceholder')}
                    />
                  </div>
                  <div className="w-16 shrink-0">
                    {idx === 0 && (
                      <Label className="text-[10px] text-muted-foreground/70 mb-1 block">{t('dropDialog.qtyLabel')}</Label>
                    )}
                    <NumberInput
                      value={item.count}
                      min={1}
                      max={20}
                      className="h-9 text-center tabular-nums"
                      clamp={n => Math.max(1, Math.min(20, n))}
                      onChange={(count) => {
                        if (!Number.isFinite(count)) return
                        setDropItems((prev) => prev.map((it, i) => (i === idx ? { ...it, count } : it)))
                        setActiveTemplateId(null)
                      }}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-9 w-9 p-0 shrink-0 text-muted-foreground/60 hover:text-destructive"
                    title={t('dropDialog.removeItemTitle')}
                    onClick={() => {
                      setDropItems((prev) => (prev.length <= 1 ? [{ itemType: '', count: 1 }] : prev.filter((_, i) => i !== idx)))
                      setActiveTemplateId(null)
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                disabled={dropItems.length >= 50}
                onClick={() => {
                  setDropItems((prev) => [...prev, { itemType: '', count: 1 }])
                  setActiveTemplateId(null)
                }}
              >
                <Plus className="w-3.5 h-3.5 me-1" />
                {t('dropDialog.addItem')}
              </Button>
              <div className="text-[11px] text-muted-foreground/70 tabular-nums">
                {t('dropDialog.validCount', { valid: dropItems.filter((it) => it.itemType.trim()).length, total: dropItems.length })}
              </div>
            </div>

            {savingTemplate ? (
              <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                <Save className="w-4 h-4 text-muted-foreground/70 flex-none" />
                <Input
                  autoFocus
                  value={templateNameInput}
                  onChange={(e) => setTemplateNameInput(e.target.value.slice(0, 40))}
                  placeholder={t('dropDialog.savePackagePlaceholder')}
                  className="h-8 flex-1"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const name = templateNameInput.trim()
                      if (!name) return
                      const valid = dropItems.filter((it) => it.itemType.trim())
                      if (valid.length === 0) {
                        toast({ title: t('toasts.cannotSaveEmptyPackage'), variant: 'destructive' })
                        return
                      }
                      const id = `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
                      const tpl: DropTemplate = { id, name, items: valid.map((it) => ({ ...it })) }
                      persistDropTemplates([...dropTemplates, tpl].slice(-50))
                      setActiveTemplateId(id)
                      setSavingTemplate(false)
                      setTemplateNameInput('')
                      toast({ title: t('toasts.packageSavedTitle'), description: name })
                    } else if (e.key === 'Escape') {
                      setSavingTemplate(false)
                      setTemplateNameInput('')
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-8"
                  disabled={!templateNameInput.trim()}
                  onClick={() => {
                    const name = templateNameInput.trim()
                    const valid = dropItems.filter((it) => it.itemType.trim())
                    if (!name || valid.length === 0) return
                    const id = `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
                    const tpl: DropTemplate = { id, name, items: valid.map((it) => ({ ...it })) }
                    persistDropTemplates([...dropTemplates, tpl].slice(-50))
                    setActiveTemplateId(id)
                    setSavingTemplate(false)
                    setTemplateNameInput('')
                    toast({ title: t('toasts.packageSavedTitle'), description: name })
                  }}
                >
                  {t('dropDialog.save')}
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => { setSavingTemplate(false); setTemplateNameInput('') }}>
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 w-full"
                disabled={dropItems.filter((it) => it.itemType.trim()).length === 0}
                onClick={() => { setSavingTemplate(true); setTemplateNameInput('') }}
              >
                <Save className="w-3.5 h-3.5 me-2" />
                {t('dropDialog.saveCurrentAsPackage')}
              </Button>
            )}

            <div className="rounded-md border border-border/50 bg-muted/10 divide-y divide-border/30">
              <label className="flex items-center justify-between gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/20 transition-colors">
                <div className="flex items-start gap-2.5 min-w-0">
                  <Megaphone className="w-4 h-4 text-muted-foreground/70 mt-0.5 flex-none" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t('dropDialog.announceToPlayers')}</div>
                    <div className="text-[11px] text-muted-foreground/70">{t('dropDialog.announceDesc')}</div>
                  </div>
                </div>
                <Switch checked={dropAnnounce} onCheckedChange={setDropAnnounce} />
              </label>
              <label className="flex items-center justify-between gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/20 transition-colors">
                <div className="flex items-start gap-2.5 min-w-0">
                  <BellRing className="w-4 h-4 text-muted-foreground/70 mt-0.5 flex-none" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t('dropDialog.attractZombies')}</div>
                    <div className="text-[11px] text-muted-foreground/70">{t('dropDialog.attractZombiesDesc')}</div>
                  </div>
                </div>
                <Switch checked={dropAttractZombies} onCheckedChange={setDropAttractZombies} />
              </label>
              {dropAttractZombies && (
                <div className="px-3 py-2.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <Label className="text-xs text-muted-foreground">{t('dropDialog.noiseRadius')}</Label>
                    <span className="text-xs font-mono tabular-nums text-muted-foreground/80">{t('dropDialog.noiseRadiusValue', { radius: dropSoundRadius })}</span>
                  </div>
                  <Input
                    type="range"
                    min={10}
                    max={500}
                    step={10}
                    value={dropSoundRadius}
                    onChange={(e) => setDropSoundRadius(parseInt(e.target.value))}
                    className="h-1.5 accent-warning"
                  />
                  <div className="flex justify-between text-[9px] text-muted-foreground/50 mt-1">
                    <span>{t('dropDialog.whisper')}</span>
                    <span>{t('dropDialog.gunshot')}</span>
                    <span>{t('dropDialog.explosion')}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDropDialog(null)}>{t('dropDialog.cancel')}</Button>
            <DisabledReason reason={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : null}>
            <Button
              disabled={dropItems.filter((it) => it.itemType.trim()).length === 0 || actionLoading === 'drop' || !canRunBridgeCommand}
              onClick={async () => {
                if (!dropDialog) return
                const valid = dropItems.filter((it) => it.itemType.trim())
                if (valid.length === 0) return
                const label = activeTemplateId
                  ? dropTemplates.find((tpl) => tpl.id === activeTemplateId)?.name
                  : valid.length === 1
                    ? valid[0].itemType.replace(/^[^.]+\./, '')
                    : t('toasts.itemPackageFallback', { count: valid.length })
                await callCustomDrop({
                  x: dropDialog.x,
                  y: dropDialog.y,
                  items: valid,
                  announce: dropAnnounce,
                  attractZombies: dropAttractZombies,
                  soundRadius: dropSoundRadius,
                  label,
                })
                if (mountedRef.current) setDropDialog(null)
              }}
            >
              {actionLoading === 'drop'
                ? <Loader2 className="w-4 h-4 me-2 animate-spin" />
                : <Flame className="w-4 h-4 me-2" />}
              {(() => {
                const validCount = dropItems.filter((it) => it.itemType.trim()).length
                const totalQty = dropItems.filter((it) => it.itemType.trim()).reduce((s, it) => s + it.count, 0)
                if (validCount === 0) return t('dropDialog.dropButton')
                if (validCount === 1) return totalQty > 1 ? t('dropDialog.dropButtonQty', { qty: totalQty }) : t('dropDialog.dropButton')
                return t('dropDialog.dropButtonMulti', { count: validCount })
              })()}
            </Button>
            </DisabledReason>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteTemplateId}
        onOpenChange={(open) => { if (!open) setDeleteTemplateId(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deletePackageDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const tpl = dropTemplates.find((d) => d.id === deleteTemplateId)
                if (!tpl) return t('deletePackageDialog.descriptionFallback')
                return t('deletePackageDialog.description', { name: tpl.name, count: tpl.items.length })
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('deletePackageDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const id = deleteTemplateId
                if (!id) return
                const tpl = dropTemplates.find((d) => d.id === id)
                persistDropTemplates(dropTemplates.filter((d) => d.id !== id))
                if (activeTemplateId === id) setActiveTemplateId(null)
                setDeleteTemplateId(null)
                if (tpl) toast({ title: t('toasts.packageDeletedTitle'), description: tpl.name })
              }}
            >
              {t('deletePackageDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!removeVehicleTarget}
        onOpenChange={(open) => { if (!open) setRemoveVehicleTarget(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('removeVehicleDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {removeVehicleTarget && t('removeVehicleDialog.description', {
                vehicle: removeVehicleTarget.label,
                x: removeVehicleTarget.x,
                y: removeVehicleTarget.y,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading === 'vehicle-remove'}>
              {t('removeVehicleDialog.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={actionLoading === 'vehicle-remove' || !canRunBridgeCommand}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                if (!canRunBridgeCommand) return
                const target = removeVehicleTarget
                if (!target) return
                setActionLoading('vehicle-remove')
                panelBridgeApi.sendCommand('removeVehicle', { vehicleId: target.id })
                  .then(() => {
                    toast({ title: t('toasts.vehicleRemoved') })
                    fetchOverlays()
                  })
                  .catch((err) => toast({ title: t('toasts.removeFailed'), description: getUserErrorMessage(err, t('toasts.unknownError')), variant: 'destructive' }))
                  .finally(() => { setActionLoading(null); setRemoveVehicleTarget(null) })
              }}
            >
              {actionLoading === 'vehicle-remove'
                ? <Loader2 className="w-4 h-4 me-2 animate-spin" />
                : <Trash2 className="w-4 h-4 me-2" />}
              {t('removeVehicleDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
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
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={loading || disabled}
      // eslint-disable-next-line local/no-dead-disabled-title -- description is rendered visibly below.
      title={description}
      className="group relative w-full pe-2 py-1.5 text-xs flex items-stretch gap-2.5 transition-colors duration-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent hover:bg-muted/45 focus-visible:bg-muted/45 focus-visible:outline-none"
    >
      <span
        aria-hidden
        className={cn(
          'w-[2px] -my-px shrink-0 border-s-2 border-transparent transition-colors',
          toneAccent[tone]
        )}
      />
      <span className="flex-none w-4 flex items-center justify-center ps-1">
        {loading
          ? <Loader2 className="w-3.5 h-3.5 animate-spin text-primary/70" />
          : icon}
      </span>
      <span className="flex flex-col min-w-0 text-start flex-1">
        <span className="truncate text-foreground">{label}</span>
        {description && <span className="text-[10px] text-muted-foreground/60 truncate leading-tight">{description}</span>}
      </span>
    </button>
  )
}

function ContextMenuSection({ label, icon, tone = 'muted' }: {
  label: string
  icon?: React.ReactNode
  tone?: 'muted' | 'primary' | 'warning' | 'info' | 'success' | 'danger'
}) {
  const toneColor: Record<NonNullable<typeof tone>, string> = {
    muted: 'text-muted-foreground/70',
    primary: 'text-primary/75',
    warning: 'text-amber-400/85',
    info: 'text-info/80',
    success: 'text-emerald-400/85',
    danger: 'text-destructive/85',
  }
  return (
    <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 font-mono text-[9px] uppercase tracking-[0.24em] select-none">
      {icon && <span className={cn('flex items-center justify-center', toneColor[tone])}>{icon}</span>}
      <span className={toneColor[tone]}>{label}</span>
      <span className="flex-1 h-px bg-border/40" />
    </div>
  )
}

function getPlayerColor(player: MapPlayer, alpha: number): string {
  if (player.isAlive === false) return hslToken('--muted-foreground', alpha)
  if (player.isInfected) return hslToken('--destructive', alpha)
  if (player.accessLevel && player.accessLevel !== '' && player.accessLevel !== 'none' && player.accessLevel !== 'user')
    return hslToken('--warning', alpha)
  return hslToken('--info', alpha)
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

function gameTileToDzi(gx: number, gy: number, cfg: MapConfig) {
  return {
    x: cfg.isoX0 + (gx - gy) * cfg.isoHalfSqr,
    y: cfg.isoY0 + (gx + gy) * cfg.isoQuarterSqr,
  }
}

function dziToGameTile(dziX: number, dziY: number, cfg: MapConfig) {
  const dx = dziX - cfg.isoX0
  const dy = dziY - cfg.isoY0
  return {
    x: dx / (2 * cfg.isoHalfSqr) + dy / (2 * cfg.isoQuarterSqr),
    y: -dx / (2 * cfg.isoHalfSqr) + dy / (2 * cfg.isoQuarterSqr),
  }
}
