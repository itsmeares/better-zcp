import '@tanstack/react-start/server-only'

import {
  sanitizeError,
  sanitizeErrorParams,
} from '../../../panel-server/utils/sanitize.ts'
import { parseClampedInteger } from '../../../panel-server/utils/queryNumbers.ts'

// Keep the existing public /api contract while the panel UI uses typed Server
// Functions. Start owns the request; the dispatcher below only supplies the
// long tail of endpoints that still need their public HTTP response shape.
type AnyRecord = Record<string, any>

type AuthenticatedUser = {
  userId: string | null
  username: string | null
  role: string
  tokenGen: number | null
  authDisabled?: boolean
}

type DirectServerFunction = ((
  data: AnyRecord,
  context: { authenticatedUser: AuthenticatedUser | null; request?: Request },
) => Promise<unknown>) & {
  __executeImplementation?: (
    data: unknown,
    context?: unknown,
  ) => Promise<unknown>
}

type ServerFunction = {
  __executeImplementation?: (
    data: unknown,
    context?: unknown,
  ) => Promise<unknown>
  __executeServer?: (options: {
    data?: unknown
    context?: unknown
  }) => Promise<{ result?: unknown; error?: unknown }>
} | DirectServerFunction

type RouteSource =
  | 'control'
  | 'integrations'
  | 'admin'
  | 'auth'
  | 'permissions'
  | 'resources'
  | 'resourceActions'
  | 'finder'
  | 'mods'
  | 'system'
  | 'fileReads'
  | 'fileWrites'
  | 'bridge'
  | 'bridgeSetup'
  | 'bridgeWorld'
  | 'bridgeEffects'
  | 'bridgePlayer'
  | 'bridgeDiagnostics'
  | 'serverServer'
  | 'panel'
  | 'http'

type RouteStatus = number | ((result: any) => number)

type RouteSpec = {
  method: string
  pattern: string
  source: RouteSource
  functionName: string
  public?: boolean
  role?: string
  capability?: string | string[]
  anyCapability?: string[]
  data?: (
    query: URLSearchParams,
    body: AnyRecord,
    params: AnyRecord,
  ) => AnyRecord
  status?: RouteStatus
  headers?: (params: AnyRecord) => Record<string, string>
  bodyError?: AnyRecord
}

type ParsedBody = {
  value: AnyRecord
  isObject: boolean
}

const START_HANDLED_HEADER = 'x-tanstack-start-handled'

const implementations: Record<
  RouteSource,
  () => Promise<Record<string, unknown>>
> = {
  control: () => import('./serverGameControl'),
  integrations: () => import('./serverIntegrations'),
  admin: () => import('./serverAdmin'),
  auth: () => import('./serverAuth'),
  permissions: () => import('./serverPermissions'),
  resources: () => import('./serverResourceReads'),
  resourceActions: () => import('./serverResourceActions'),
  finder: () => import('./serverFinder'),
  mods: () => import('./serverMods'),
  system: () => import('./serverSystem'),
  fileReads: () => import('./serverFileReads'),
  fileWrites: () => import('./serverFileReads'),
  bridge: () => import('./serverPanelBridge'),
  bridgeSetup: () => import('./serverPanelBridgeSetup'),
  bridgeWorld: () => import('./serverPanelBridgeWorld'),
  bridgeEffects: () => import('./serverPanelBridgeEffects'),
  bridgePlayer: () => import('./serverPanelBridgePlayerChat'),
  bridgeDiagnostics: () => import('./serverPanelBridgeDiagnostics'),
  serverServer: () => import('./serverServerApi'),
  panel: () => import('./serverPanelUpdate'),
  http: () => import('./serverHttpApi'),
}

const sourceCapabilities: Partial<Record<RouteSource, string>> = {
  mods: 'mods.manage',
  fileReads: 'serverfiles.manage',
  fileWrites: 'serverfiles.manage',
}

function mergeBody(
  _query: URLSearchParams,
  body: AnyRecord,
  params: AnyRecord,
): AnyRecord {
  return { ...body, ...params }
}

function queryData(...keys: string[]) {
  return (query: URLSearchParams): AnyRecord => {
    const data: AnyRecord = {}
    for (const key of keys) {
      if (query.has(key)) data[key] = query.get(key)
    }
    return data
  }
}

function performanceHistoryData(query: URLSearchParams): AnyRecord {
  return { limit: parseClampedInteger(query.get('limit'), 60, 1, 1440) }
}

function matchPattern(pattern: string, pathname: string): AnyRecord | null {
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = pathname.replace(/\/+$/, '').split('/').filter(Boolean)
  if (patternParts.length !== pathParts.length) return null

  const params: AnyRecord = {}
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index]
    const pathPart = pathParts[index]
    if (patternPart.startsWith(':')) {
      try {
        params[patternPart.slice(1)] = decodeURIComponent(pathPart)
      } catch {
        return null
      }
      continue
    }
    if (patternPart !== pathPart) return null
  }
  return params
}

function bridgeActionData(
  action: string,
  _query: URLSearchParams,
  body: AnyRecord,
  params: AnyRecord,
): AnyRecord {
  return { action, args: { ...body, ...params } }
}

function bridgeAction(action: string) {
  return (query: URLSearchParams, body: AnyRecord, params: AnyRecord) =>
    bridgeActionData(action, query, body, params)
}

function bridgeCommandData(
  _query: URLSearchParams,
  body: AnyRecord,
  params: AnyRecord,
): AnyRecord {
  return { ...body, ...params }
}

const panelBridgeRoutes: RouteSpec[] = [
  {
    method: 'GET',
    pattern: '/api/panel-bridge/status',
    source: 'bridgeSetup',
    functionName: 'getPanelBridgeStatus',
    anyCapability: ['bridge.setup', 'bridge.diagnostics'],
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/ping',
    source: 'bridgeSetup',
    functionName: 'pingPanelBridge',
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/auto-configure',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('autoConfigure'),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/scan-server/:serverId',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('scanServer'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/auto-detect',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('autoDetect'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/configure',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('configure'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/configure-direct',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('configureDirect'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/sftp/test',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('testSftp'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/sftp/configure',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('configureSftp'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/sftp/logs/list',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('listSftpLogs'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/sftp/logs/tail',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('tailSftpLog'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/sftp/config/list',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('listRemoteConfig'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/start',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('start'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/stop',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('stop'),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/scan-paths',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('scanPaths'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/refresh',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('refresh'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/command',
    source: 'bridge',
    functionName: 'sendPanelBridgeCommand',
    data: bridgeCommandData,
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/weather',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('getWeather'),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/server-info',
    source: 'bridgeWorld',
    functionName: 'getPanelBridgeServerInfo',
    capability: 'players.view',
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/weather/blizzard',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('triggerBlizzard'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/weather/tropical-storm',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('triggerTropicalStorm'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/weather/storm',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('triggerStorm'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/weather/stop',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('stopWeather'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/weather/generate',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('generateWeather'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/weather/snow',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('setSnow'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/weather/rain/start',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('startRain'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/weather/rain/stop',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('stopRain'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/weather/lightning',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('triggerLightning'),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/climate/floats',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('getClimateFloats'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/climate/float',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('setClimateFloat'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/climate/reset',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('resetClimateOverrides'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/climate/temperature',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('setTemperature'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/climate/wind',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('setWind'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/climate/fog',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('setFog'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/climate/clouds',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('setClouds'),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/time',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('getGameTime'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/time',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('setGameTime'),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/world/stats',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('getWorldStats'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/world/save',
    source: 'bridgeWorld',
    functionName: 'savePanelBridgeWorld',
    capability: 'server.control',
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/sandbox',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'players.gm_tools',
    data: bridgeAction('getSandboxOptions'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/sound/world',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('playWorldSound'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/sound/near-player',
    source: 'bridgeEffects',
    functionName: 'sendPanelBridgeEndangerCommand',
    capability: 'players.endanger_or_impersonate',
    data: bridgeAction('playSoundNearPlayer'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/sound/gunshot',
    source: 'bridgeEffects',
    functionName: 'sendPanelBridgeEndangerCommand',
    capability: 'players.endanger_or_impersonate',
    data: bridgeAction('triggerGunshot'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/sound/alarm',
    source: 'bridgeEffects',
    functionName: 'sendPanelBridgeEndangerCommand',
    capability: 'players.endanger_or_impersonate',
    data: bridgeAction('triggerAlarmSound'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/sound/noise',
    source: 'bridgeEffects',
    functionName: 'sendPanelBridgeEndangerCommand',
    capability: 'players.endanger_or_impersonate',
    data: bridgeAction('createNoise'),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/utilities/status',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('getUtilitiesStatus'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/utilities/restore',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('restoreUtilities'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/utilities/shutoff',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('shutOffUtilities'),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/players',
    source: 'bridgePlayer',
    functionName: 'sendPanelBridgePlayerCommand',
    capability: 'players.gm_tools',
    data: bridgeAction('getAllPlayerDetails'),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/players/:username',
    source: 'bridgePlayer',
    functionName: 'sendPanelBridgePlayerCommand',
    capability: 'players.gm_tools',
    data: bridgeAction('getPlayerDetails'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/players/:username/teleport',
    source: 'bridgePlayer',
    functionName: 'sendPanelBridgePlayerCommand',
    capability: 'players.gm_tools',
    data: bridgeAction('teleportPlayer'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/message',
    source: 'bridgePlayer',
    functionName: 'sendPanelBridgeServerMessage',
    capability: 'server.world_events',
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/character/export',
    source: 'bridgePlayer',
    functionName: 'sendPanelBridgePlayerCommand',
    capability: 'players.gm_tools',
    data: bridgeAction('exportPlayerData'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/character/import',
    source: 'bridgePlayer',
    functionName: 'sendPanelBridgePlayerCommand',
    capability: 'players.gm_tools',
    data: bridgeAction('importPlayerData'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/players/:username/give-item',
    source: 'bridgePlayer',
    functionName: 'sendPanelBridgePlayerCommand',
    capability: 'players.gm_tools',
    data: bridgeAction('giveItem'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/players/:username/heal',
    source: 'bridgePlayer',
    functionName: 'sendPanelBridgePlayerCommand',
    capability: 'players.gm_tools',
    data: bridgeAction('healPlayer'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/players/:username/kill',
    source: 'bridgePlayer',
    functionName: 'sendPanelBridgePlayerCommand',
    capability: 'players.gm_tools',
    data: bridgeAction('killPlayer'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/players/:username/godmode',
    source: 'bridgePlayer',
    functionName: 'sendPanelBridgePlayerCommand',
    capability: 'players.gm_tools',
    data: bridgeAction('setGodMode'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/players/:username/invisible',
    source: 'bridgePlayer',
    functionName: 'sendPanelBridgePlayerCommand',
    capability: 'players.gm_tools',
    data: bridgeAction('setInvisible'),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/zombies/count',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('getZombieCount'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/zombies/clear-near-player',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('clearZombiesNearPlayer'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/zombies/clear-all',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('clearAllZombies'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/zombies/spawn-near',
    source: 'bridgeEffects',
    functionName: 'sendPanelBridgeEndangerCommand',
    capability: 'players.endanger_or_impersonate',
    data: bridgeAction('spawnHordeNearPlayer'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/zombies/spawn-behind',
    source: 'bridgeEffects',
    functionName: 'sendPanelBridgeEndangerCommand',
    capability: 'players.endanger_or_impersonate',
    data: bridgeAction('spawnHordeBehindPlayer'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/visual/view-distance',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('setViewDistance'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/visual/daylight',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('setDayLight'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/visual/night-strength',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('setNightStrength'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/visual/desaturation',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('setDesaturation'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/visual/ambient',
    source: 'bridgeWorld',
    functionName: 'sendPanelBridgeWorldCommand',
    capability: 'server.world_events',
    data: bridgeAction('setAmbient'),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/chat/info',
    source: 'bridgePlayer',
    functionName: 'getPanelBridgeChatInfo',
    capability: 'server.world_events',
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/chat/admin',
    source: 'bridgePlayer',
    functionName: 'sendPanelBridgeAdminChat',
    capability: 'players.endanger_or_impersonate',
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/chat/general',
    source: 'bridgePlayer',
    functionName: 'sendPanelBridgeGeneralChat',
    capability: 'players.endanger_or_impersonate',
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/chat/alert',
    source: 'bridgePlayer',
    functionName: 'sendPanelBridgeChatAlert',
    capability: 'server.world_events',
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/debug/log',
    source: 'bridgeDiagnostics',
    functionName: 'sendPanelBridgeDiagnosticsCommand',
    capability: 'bridge.diagnostics',
    data: (query, _body, _params) => ({
      action: 'getDebugLog',
      args: {
        limit: query.get('limit'),
        level: query.get('level'),
      },
    }),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/debug/stats',
    source: 'bridgeDiagnostics',
    functionName: 'sendPanelBridgeDiagnosticsCommand',
    capability: 'bridge.diagnostics',
    data: bridgeAction('getStats'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/debug/mode',
    source: 'bridgeDiagnostics',
    functionName: 'sendPanelBridgeDiagnosticsCommand',
    capability: 'bridge.diagnostics',
    data: bridgeAction('setDebugMode'),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/debug/api',
    source: 'bridgeDiagnostics',
    functionName: 'sendPanelBridgeDiagnosticsCommand',
    capability: 'bridge.diagnostics',
    data: (query, _body, _params) => ({
      action: 'checkAPI',
      args: { object: query.get('object'), method: query.get('method') },
    }),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/debug/handlers',
    source: 'bridgeDiagnostics',
    functionName: 'sendPanelBridgeDiagnosticsCommand',
    capability: 'bridge.diagnostics',
    data: bridgeAction('getAvailableHandlers'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/debug/clear-errors',
    source: 'bridgeDiagnostics',
    functionName: 'sendPanelBridgeDiagnosticsCommand',
    capability: 'bridge.diagnostics',
    data: bridgeAction('clearErrors'),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/catalog/items',
    source: 'bridgeEffects',
    functionName: 'getPanelBridgeCatalog',
    capability: 'players.gm_tools',
    data: () => ({ kind: 'items' }),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/catalog/vehicles',
    source: 'bridgeEffects',
    functionName: 'getPanelBridgeCatalog',
    capability: 'players.gm_tools',
    data: () => ({ kind: 'vehicles' }),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/catalog/scan-items',
    source: 'bridgeEffects',
    functionName: 'scanPanelBridgeCatalog',
    capability: 'bridge.diagnostics',
    data: () => ({ kind: 'items' }),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/catalog/scan-vehicles',
    source: 'bridgeEffects',
    functionName: 'scanPanelBridgeCatalog',
    capability: 'bridge.diagnostics',
    data: () => ({ kind: 'vehicles' }),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/catalog/debug-item-script',
    source: 'bridgeDiagnostics',
    functionName: 'sendPanelBridgeDiagnosticsCommand',
    capability: 'bridge.diagnostics',
    data: bridgeAction('debugItemScript'),
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/commands',
    source: 'bridge',
    functionName: 'getPanelBridgeCommands',
  },
  {
    method: 'GET',
    pattern: '/api/panel-bridge/mod-path',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('getModPath'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/install-local',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('installLocal'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/install-mod-auto',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('installModAuto'),
  },
  {
    method: 'POST',
    pattern: '/api/panel-bridge/install-mod',
    source: 'bridgeSetup',
    functionName: 'sendPanelBridgeSetupCommand',
    capability: 'bridge.setup',
    data: bridgeAction('installMod'),
  },
]

const routes: RouteSpec[] = [
  ...panelBridgeRoutes,
  {
    method: 'GET',
    pattern: '/api/rcon/status',
    source: 'control',
    functionName: 'getRconStatus',
  },
  {
    method: 'POST',
    pattern: '/api/rcon/execute',
    source: 'control',
    functionName: 'executeRcon',
    capability: 'rcon.execute',
  },
  {
    method: 'POST',
    pattern: '/api/rcon/connect',
    source: 'control',
    functionName: 'connectRcon',
    capability: 'rcon.execute',
    bodyError: { success: false, error: 'Request body must be an object' },
  },
  {
    method: 'POST',
    pattern: '/api/rcon/test',
    source: 'control',
    functionName: 'testRconConnection',
    capability: ['rcon.execute', 'servers.manage'],
    status: (result) =>
      result?.error === 'invalid_input'
        ? 400
        : result?.error === 'internal_error'
          ? 500
          : 200,
  },
  {
    method: 'GET',
    pattern: '/api/rcon/health',
    source: 'control',
    functionName: 'getRconHealth',
    status: (result) => (result?.success === false ? 503 : 200),
  },
  {
    method: 'POST',
    pattern: '/api/rcon/disconnect',
    source: 'control',
    functionName: 'disconnectRcon',
    capability: 'rcon.execute',
  },
  {
    method: 'GET',
    pattern: '/api/rcon/history',
    source: 'control',
    functionName: 'getRconHistory',
    capability: 'rcon.execute',
    data: queryData('limit'),
  },
  {
    method: 'GET',
    pattern: '/api/rcon/commands/:category',
    source: 'control',
    functionName: 'getRconCommands',
    data: (_query, _body, params) => ({ category: params.category }),
  },
  {
    method: 'GET',
    pattern: '/api/rcon/commands',
    source: 'control',
    functionName: 'getRconCommands',
  },

  {
    method: 'GET',
    pattern: '/api/server/status',
    source: 'control',
    functionName: 'getGameServerStatus',
  },
  {
    method: 'GET',
    pattern: '/api/server/network-interfaces',
    source: 'control',
    functionName: 'getNetworkInterfaces',
  },
  {
    method: 'GET',
    pattern: '/api/servers',
    source: 'control',
    functionName: 'getManagedServers',
  },
  {
    method: 'GET',
    pattern: '/api/servers/active',
    source: 'control',
    functionName: 'getActiveManagedServer',
  },
  {
    method: 'GET',
    pattern: '/api/servers/status',
    source: 'control',
    functionName: 'getManagedServersStatus',
  },
  {
    method: 'GET',
    pattern: '/api/servers/rcon-status',
    source: 'control',
    functionName: 'getManagedServersRconStatus',
  },
  {
    method: 'GET',
    pattern: '/api/servers/active/status',
    source: 'control',
    functionName: 'getActiveComposedStatus',
  },
  {
    method: 'GET',
    pattern: '/api/servers/:id/lifecycle-template',
    source: 'control',
    functionName: 'getLifecycleTemplate',
    capability: 'servers.manage',
    data: (query, _body, params) => ({
      id: params.id,
      ...(query.has('provider') ? { provider: query.get('provider') } : {}),
      ...(query.has('serviceUser')
        ? { serviceUser: query.get('serviceUser') }
        : {}),
    }),
  },
  {
    method: 'GET',
    pattern: '/api/servers/discover-mounts',
    source: 'control',
    functionName: 'getDiscoveredMounts',
    capability: 'servers.discover',
  },
  {
    method: 'GET',
    pattern: '/api/servers/:id',
    source: 'control',
    functionName: 'getManagedServer',
  },
  {
    method: 'POST',
    pattern: '/api/servers/create-from-discovery',
    source: 'control',
    functionName: 'createServerFromDiscovery',
    capability: 'servers.discover',
    status: 201,
  },
  {
    method: 'POST',
    pattern: '/api/servers',
    source: 'control',
    functionName: 'createManagedServer',
    capability: 'servers.manage',
    status: 201,
  },
  {
    method: 'PUT',
    pattern: '/api/servers/:id',
    source: 'control',
    functionName: 'updateManagedServer',
    capability: 'servers.manage',
    data: (_query, body, params) => ({ id: params.id, updates: body }),
  },
  {
    method: 'DELETE',
    pattern: '/api/servers/:id',
    source: 'control',
    functionName: 'deleteManagedServer',
    capability: 'servers.manage',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/servers/:id/activate',
    source: 'control',
    functionName: 'activateManagedServer',
    capability: 'servers.manage',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/servers/:id/lifecycle-provider',
    source: 'control',
    functionName: 'activateManagedLifecycleProvider',
    capability: 'servers.manage',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/server/start',
    source: 'control',
    functionName: 'startServer',
    capability: 'server.control',
  },
  {
    method: 'POST',
    pattern: '/api/server/stop',
    source: 'control',
    functionName: 'stopServer',
    capability: 'server.control',
  },
  {
    method: 'POST',
    pattern: '/api/server/force-stop',
    source: 'control',
    functionName: 'forceStopServer',
    capability: 'server.control',
  },
  {
    method: 'POST',
    pattern: '/api/server/restart',
    source: 'control',
    functionName: 'restartServer',
    capability: 'server.control',
  },
  {
    method: 'POST',
    pattern: '/api/server/save',
    source: 'control',
    functionName: 'saveGameWorld',
    capability: 'server.control',
  },
  {
    method: 'POST',
    pattern: '/api/server/message',
    source: 'control',
    functionName: 'sendServerMessage',
    capability: 'server.world_events',
  },
  {
    method: 'POST',
    pattern: '/api/server/weather/start-rain',
    source: 'control',
    functionName: 'startRain',
    capability: 'server.world_events',
  },
  {
    method: 'POST',
    pattern: '/api/server/weather/stop-rain',
    source: 'control',
    functionName: 'stopRain',
    capability: 'server.world_events',
  },
  {
    method: 'POST',
    pattern: '/api/server/weather/start-storm',
    source: 'control',
    functionName: 'startStorm',
    capability: 'server.world_events',
  },
  {
    method: 'POST',
    pattern: '/api/server/weather/stop',
    source: 'control',
    functionName: 'stopWeather',
    capability: 'server.world_events',
  },
  {
    method: 'POST',
    pattern: '/api/server/events/chopper',
    source: 'control',
    functionName: 'triggerChopper',
    capability: 'server.world_events',
  },
  {
    method: 'POST',
    pattern: '/api/server/events/gunshot',
    source: 'control',
    functionName: 'triggerGunshot',
    capability: 'server.world_events',
  },
  {
    method: 'POST',
    pattern: '/api/server/events/lightning',
    source: 'control',
    functionName: 'triggerLightning',
    capability: 'players.endanger_or_impersonate',
  },
  {
    method: 'POST',
    pattern: '/api/server/events/thunder',
    source: 'control',
    functionName: 'triggerThunder',
    capability: 'players.endanger_or_impersonate',
  },
  {
    method: 'POST',
    pattern: '/api/server/events/horde',
    source: 'control',
    functionName: 'createHorde',
    capability: 'players.endanger_or_impersonate',
  },
  {
    method: 'POST',
    pattern: '/api/server/reloadlua',
    source: 'control',
    functionName: 'reloadLua',
    capability: 'server.configure',
  },
  {
    method: 'POST',
    pattern: '/api/server/log',
    source: 'control',
    functionName: 'setLogLevel',
    capability: 'server.configure',
  },
  {
    method: 'POST',
    pattern: '/api/server/stats',
    source: 'control',
    functionName: 'setServerStats',
    capability: 'server.configure',
  },
  {
    method: 'POST',
    pattern: '/api/server/alarm',
    source: 'control',
    functionName: 'alarm',
    capability: 'server.world_events',
  },
  {
    method: 'POST',
    pattern: '/api/server/removezombies',
    source: 'control',
    functionName: 'removeZombies',
    capability: 'server.world_events',
  },
  {
    method: 'POST',
    pattern: '/api/server/releasesafehouse',
    source: 'control',
    functionName: 'releaseSafehouse',
    capability: 'server.world_events',
  },
  {
    method: 'GET',
    pattern: '/api/server/steamcmd/check',
    source: 'serverServer',
    functionName: 'checkSteamCmd',
    capability: 'server.install',
    data: queryData('path'),
  },
  {
    method: 'POST',
    pattern: '/api/server/configure-rcon',
    source: 'serverServer',
    functionName: 'configureRcon',
    capability: 'server.configure',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/server/configure-network',
    source: 'serverServer',
    functionName: 'configureNetwork',
    capability: 'server.configure',
    data: mergeBody,
  },
  {
    method: 'GET',
    pattern: '/api/server/console-log',
    source: 'serverServer',
    functionName: 'getConsoleLog',
    capability: 'server.world_events',
    data: queryData('lines', 'filter'),
  },
  {
    method: 'GET',
    pattern: '/api/server/console-log/error-count',
    source: 'serverServer',
    functionName: 'getConsoleErrorCount',
    capability: 'server.world_events',
  },
  {
    method: 'GET',
    pattern: '/api/server/console-log/stream',
    source: 'serverServer',
    functionName: 'getConsoleLogStream',
    capability: 'server.world_events',
    data: queryData('lastSize', 'filter'),
  },
  {
    method: 'POST',
    pattern: '/api/server/console-log/clear',
    source: 'serverServer',
    functionName: 'clearConsoleLog',
    capability: 'server.configure',
    data: mergeBody,
  },
  {
    method: 'GET',
    pattern: '/api/server/update-check',
    source: 'serverServer',
    functionName: 'getServerUpdate',
    capability: 'server.world_events',
    data: queryData('force'),
  },
  {
    method: 'GET',
    pattern: '/api/server/update-check/status',
    source: 'serverServer',
    functionName: 'getServerUpdateStatus',
    capability: 'server.world_events',
  },
  {
    method: 'POST',
    pattern: '/api/server/update-check/auto-update-result/dismiss',
    source: 'serverServer',
    functionName: 'dismissServerAutoUpdateResult',
    capability: 'server.world_events',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/server/update-check/interval',
    source: 'serverServer',
    functionName: 'setServerUpdateInterval',
    capability: 'server.configure',
    data: mergeBody,
  },
  {
    method: 'GET',
    pattern: '/api/map/vehicles',
    source: 'serverServer',
    functionName: 'getMapVehicles',
  },
  {
    method: 'POST',
    pattern: '/api/panel/restart',
    source: 'panel',
    functionName: 'restartPanel',
    role: 'admin',
  },
  {
    method: 'GET',
    pattern: '/api/panel/update-check',
    source: 'panel',
    functionName: 'checkPanelUpdate',
  },
  {
    method: 'GET',
    pattern: '/api/panel/update-status',
    source: 'panel',
    functionName: 'getPanelUpdateStatus',
  },
  {
    method: 'GET',
    pattern: '/api/panel/update-preflight',
    source: 'panel',
    functionName: 'getPanelUpdatePreflight',
  },
  {
    method: 'GET',
    pattern: '/api/panel/update-apply-log',
    source: 'panel',
    functionName: 'getPanelUpdateApplyLog',
  },
  {
    method: 'POST',
    pattern: '/api/panel/update-download',
    source: 'panel',
    functionName: 'downloadPanelUpdate',
    role: 'admin',
    data: mergeBody,
  },

  {
    method: 'GET',
    pattern: '/api/players/activity',
    source: 'resources',
    functionName: 'getPlayerActivity',
    capability: 'players.view',
    data: queryData('player', 'limit'),
  },
  {
    method: 'GET',
    pattern: '/api/players',
    source: 'control',
    functionName: 'getPlayers',
    capability: 'players.view',
  },
  {
    method: 'POST',
    pattern: '/api/players/kick',
    source: 'control',
    functionName: 'kickPlayer',
    capability: 'players.moderate',
  },
  {
    method: 'POST',
    pattern: '/api/players/ban',
    source: 'control',
    functionName: 'banPlayer',
    capability: 'players.moderate',
  },
  {
    method: 'POST',
    pattern: '/api/players/unban',
    source: 'control',
    functionName: 'unbanPlayer',
    capability: 'players.moderate',
  },
  {
    method: 'POST',
    pattern: '/api/players/whitelist/add',
    source: 'control',
    functionName: 'addToWhitelist',
    capability: 'players.moderate',
  },
  {
    method: 'POST',
    pattern: '/api/players/whitelist/remove',
    source: 'control',
    functionName: 'removeFromWhitelist',
    capability: 'players.moderate',
  },
  {
    method: 'POST',
    pattern: '/api/players/teleport',
    source: 'control',
    functionName: 'teleportPlayer',
    capability: 'players.gm_tools',
  },
  {
    method: 'POST',
    pattern: '/api/players/add-item',
    source: 'control',
    functionName: 'addPlayerItem',
    capability: 'players.gm_tools',
  },
  {
    method: 'POST',
    pattern: '/api/players/add-xp',
    source: 'control',
    functionName: 'addPlayerXp',
    capability: 'players.gm_tools',
  },
  {
    method: 'POST',
    pattern: '/api/players/add-vehicle',
    source: 'control',
    functionName: 'addPlayerVehicle',
    capability: 'players.gm_tools',
  },
  {
    method: 'POST',
    pattern: '/api/players/add-vehicle-at',
    source: 'control',
    functionName: 'addPlayerVehicleAt',
    capability: 'players.gm_tools',
  },
  {
    method: 'POST',
    pattern: '/api/players/godmode',
    source: 'control',
    functionName: 'setGodMode',
    capability: 'players.gm_tools',
  },
  {
    method: 'POST',
    pattern: '/api/players/invisible',
    source: 'control',
    functionName: 'setInvisible',
    capability: 'players.gm_tools',
  },
  {
    method: 'POST',
    pattern: '/api/players/noclip',
    source: 'control',
    functionName: 'setNoclip',
    capability: 'players.gm_tools',
  },
  {
    method: 'GET',
    pattern: '/api/players/vehicles',
    source: 'control',
    functionName: 'getPlayerVehicles',
    capability: 'players.view',
  },
  {
    method: 'GET',
    pattern: '/api/players/perks',
    source: 'control',
    functionName: 'getPlayerPerks',
    capability: 'players.view',
  },
  {
    method: 'GET',
    pattern: '/api/players/access-levels',
    source: 'control',
    functionName: 'getPlayerAccessLevels',
    capability: 'players.view',
  },
  {
    method: 'POST',
    pattern: '/api/players/access-level',
    source: 'control',
    functionName: 'setAccessLevel',
    capability: 'players.moderate',
  },
  {
    method: 'GET',
    pattern: '/api/players/steamid-bans',
    source: 'control',
    functionName: 'getSteamIdBans',
    capability: 'players.view',
  },
  {
    method: 'POST',
    pattern: '/api/players/banid',
    source: 'control',
    functionName: 'banSteamId',
    capability: 'players.moderate',
  },
  {
    method: 'POST',
    pattern: '/api/players/unbanid',
    source: 'control',
    functionName: 'unbanSteamId',
    capability: 'players.moderate',
  },
  {
    method: 'POST',
    pattern: '/api/players/voiceban',
    source: 'control',
    functionName: 'setVoiceBan',
    capability: 'players.moderate',
  },
  {
    method: 'POST',
    pattern: '/api/players/adduser',
    source: 'control',
    functionName: 'addRconUser',
    capability: 'players.moderate',
  },
  {
    method: 'POST',
    pattern: '/api/players/whitelist/addall',
    source: 'control',
    functionName: 'addAllToWhitelist',
    capability: 'players.moderate',
  },
  {
    method: 'POST',
    pattern: '/api/players/whitelist/steamid/add',
    source: 'control',
    functionName: 'addAllowedSteamId',
    capability: 'players.moderate',
  },
  {
    method: 'POST',
    pattern: '/api/players/whitelist/steamid/remove',
    source: 'control',
    functionName: 'removeAllowedSteamId',
    capability: 'players.moderate',
  },
  {
    method: 'GET',
    pattern: '/api/players/whitelist',
    source: 'control',
    functionName: 'getWhitelist',
    capability: 'players.view',
  },
  {
    method: 'GET',
    pattern: '/api/players/notes',
    source: 'resources',
    functionName: 'getPlayerNotes',
    capability: 'players.view',
  },
  {
    method: 'GET',
    pattern: '/api/players/notes/:playerName',
    source: 'resources',
    functionName: 'getPlayerNote',
    capability: 'players.view',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/players/notes',
    source: 'resourceActions',
    functionName: 'upsertPlayerNote',
    capability: 'players.moderate',
  },
  {
    method: 'DELETE',
    pattern: '/api/players/notes/:playerName',
    source: 'resourceActions',
    functionName: 'deletePlayerNote',
    capability: 'players.moderate',
    data: mergeBody,
  },
  {
    method: 'GET',
    pattern: '/api/players/exports',
    source: 'resources',
    functionName: 'getPlayerExports',
    capability: 'players.gm_tools',
    data: queryData('username'),
  },
  {
    method: 'GET',
    pattern: '/api/players/exports/:username/:filename',
    source: 'resources',
    functionName: 'getPlayerExport',
    capability: 'players.gm_tools',
    data: mergeBody,
  },
  {
    method: 'DELETE',
    pattern: '/api/players/exports/:username/:filename',
    source: 'resourceActions',
    functionName: 'deletePlayerExport',
    capability: 'players.gm_tools',
    data: mergeBody,
  },
  {
    method: 'GET',
    pattern: '/api/players/stats',
    source: 'resources',
    functionName: 'getPlayerStats',
    capability: 'players.view',
  },
  {
    method: 'GET',
    pattern: '/api/players/stats/:playerName',
    source: 'resources',
    functionName: 'getPlayerStat',
    capability: 'players.view',
    data: mergeBody,
  },

  {
    method: 'GET',
    pattern: '/api/scheduler/status',
    source: 'control',
    functionName: 'getSchedulerStatus',
    capability: 'automation.manage',
  },
  {
    method: 'PUT',
    pattern: '/api/scheduler/timezone',
    source: 'control',
    functionName: 'setSchedulerTimezone',
    capability: 'automation.manage',
  },
  {
    method: 'PUT',
    pattern: '/api/scheduler/restart-warning',
    source: 'control',
    functionName: 'setSchedulerRestartWarning',
    capability: 'automation.manage',
  },
  {
    method: 'GET',
    pattern: '/api/scheduler/tasks',
    source: 'control',
    functionName: 'getSchedulerTasks',
    capability: 'automation.manage',
  },
  {
    method: 'POST',
    pattern: '/api/scheduler/validate-cron',
    source: 'control',
    functionName: 'validateSchedulerCron',
    capability: 'automation.manage',
  },
  {
    method: 'POST',
    pattern: '/api/scheduler/tasks',
    source: 'control',
    functionName: 'createScheduledTaskAction',
    capability: 'automation.manage',
    bodyError: {
      error: 'Request body must be an object',
      code: 'SCHEDULER_REQUEST_BODY_INVALID',
    },
  },
  {
    method: 'PUT',
    pattern: '/api/scheduler/tasks/:id',
    source: 'control',
    functionName: 'updateScheduledTaskAction',
    capability: 'automation.manage',
    data: mergeBody,
    bodyError: {
      error: 'Request body must be an object',
      code: 'SCHEDULER_REQUEST_BODY_INVALID',
    },
  },
  {
    method: 'DELETE',
    pattern: '/api/scheduler/tasks/:id',
    source: 'control',
    functionName: 'deleteScheduledTask',
    capability: 'automation.manage',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/scheduler/tasks/:id/run',
    source: 'control',
    functionName: 'runScheduledTask',
    capability: 'automation.manage',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/scheduler/restart-now',
    source: 'control',
    functionName: 'restartScheduledServer',
    capability: 'automation.manage',
  },
  {
    method: 'GET',
    pattern: '/api/scheduler/cron-presets',
    source: 'control',
    functionName: 'getSchedulerPresets',
    capability: 'automation.manage',
  },
  {
    method: 'GET',
    pattern: '/api/scheduler/history',
    source: 'control',
    functionName: 'getSchedulerHistory',
    capability: 'automation.manage',
    data: queryData('limit', 'taskId'),
  },
  {
    method: 'DELETE',
    pattern: '/api/scheduler/history',
    source: 'control',
    functionName: 'clearSchedulerHistory',
    capability: 'automation.manage',
  },

  {
    method: 'GET',
    pattern: '/api/discord/status',
    source: 'integrations',
    functionName: 'getDiscordStatus',
    capability: 'integrations.manage',
  },
  {
    method: 'GET',
    pattern: '/api/discord/config',
    source: 'integrations',
    functionName: 'getDiscordConfig',
    capability: 'integrations.manage',
  },
  {
    method: 'PUT',
    pattern: '/api/discord/config',
    source: 'integrations',
    functionName: 'updateDiscordConfig',
    capability: 'integrations.manage',
  },
  {
    method: 'POST',
    pattern: '/api/discord/start',
    source: 'integrations',
    functionName: 'startDiscordBot',
    capability: 'integrations.manage',
  },
  {
    method: 'POST',
    pattern: '/api/discord/stop',
    source: 'integrations',
    functionName: 'stopDiscordBot',
    capability: 'integrations.manage',
  },
  {
    method: 'POST',
    pattern: '/api/discord/reset',
    source: 'integrations',
    functionName: 'resetDiscordConfig',
    capability: 'integrations.manage',
  },
  {
    method: 'POST',
    pattern: '/api/discord/test',
    source: 'integrations',
    functionName: 'testDiscordToken',
    capability: 'integrations.manage',
  },
  {
    method: 'POST',
    pattern: '/api/discord/test-message',
    source: 'integrations',
    functionName: 'sendDiscordTestMessage',
    capability: 'integrations.manage',
  },
  {
    method: 'GET',
    pattern: '/api/discord/webhook-events',
    source: 'integrations',
    functionName: 'getDiscordWebhookEvents',
    capability: 'integrations.manage',
  },
  {
    method: 'PUT',
    pattern: '/api/discord/webhook-events',
    source: 'integrations',
    functionName: 'updateDiscordWebhookEvents',
    capability: 'integrations.manage',
  },
  {
    method: 'GET',
    pattern: '/api/discord/permissions',
    source: 'integrations',
    functionName: 'getDiscordPermissions',
    capability: 'integrations.manage',
  },
  {
    method: 'PUT',
    pattern: '/api/discord/permissions',
    source: 'integrations',
    functionName: 'updateDiscordPermissions',
    capability: 'integrations.manage',
  },

  {
    method: 'GET',
    pattern: '/api/docker/status',
    source: 'integrations',
    functionName: 'getDockerStatus',
    capability: 'docker.manage',
  },
  {
    method: 'GET',
    pattern: '/api/docker/stats',
    source: 'integrations',
    functionName: 'getDockerStats',
    capability: 'docker.manage',
  },
  {
    method: 'POST',
    pattern: '/api/docker/containers/:id/:action',
    source: 'integrations',
    functionName: 'runDockerAction',
    capability: 'docker.manage',
    data: mergeBody,
  },

  {
    method: 'GET',
    pattern: '/api/permissions/capabilities',
    source: 'permissions',
    functionName: 'getCapabilities',
    capability: 'roles.manage',
  },
  {
    method: 'GET',
    pattern: '/api/permissions/roles',
    source: 'permissions',
    functionName: 'getRoles',
    capability: 'roles.manage',
  },
  {
    method: 'POST',
    pattern: '/api/permissions/roles',
    source: 'admin',
    functionName: 'createManagedRole',
    capability: 'roles.manage',
    status: 201,
  },
  {
    method: 'PUT',
    pattern: '/api/permissions/roles/:id',
    source: 'admin',
    functionName: 'updateManagedRole',
    capability: 'roles.manage',
    data: mergeBody,
  },
  {
    method: 'DELETE',
    pattern: '/api/permissions/roles/:id',
    source: 'admin',
    functionName: 'deleteManagedRole',
    capability: 'roles.manage',
    data: (query, body, params) => ({
      ...body,
      ...params,
      ...(query.has('reassignTo')
        ? { reassignTo: query.get('reassignTo') }
        : {}),
    }),
  },

  {
    method: 'GET',
    pattern: '/api/templates/hidden',
    source: 'resources',
    functionName: 'getHiddenTemplates',
    capability: 'templates.manage',
  },
  {
    method: 'GET',
    pattern: '/api/templates/:id/export',
    source: 'resources',
    functionName: 'exportTemplate',
    headers: (params) => ({
      'Content-Disposition': `attachment; filename="${String(params.id).replace(
        /["\\\r\n]/g,
        '_',
      )}.json"`,
    }),
  },
  {
    method: 'GET',
    pattern: '/api/templates/:id',
    source: 'resources',
    functionName: 'getTemplate',
    data: mergeBody,
  },
  {
    method: 'GET',
    pattern: '/api/templates',
    source: 'resources',
    functionName: 'getTemplates',
  },
  {
    method: 'POST',
    pattern: '/api/templates/import',
    source: 'resourceActions',
    functionName: 'importTemplate',
    capability: 'templates.manage',
  },
  {
    method: 'POST',
    pattern: '/api/templates/:id/preview',
    source: 'resourceActions',
    functionName: 'previewTemplate',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/templates/:id/apply',
    source: 'resourceActions',
    functionName: 'applyTemplate',
    capability: 'templates.manage',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/templates',
    source: 'resourceActions',
    functionName: 'createTemplate',
    capability: 'templates.manage',
  },
  {
    method: 'DELETE',
    pattern: '/api/templates/:id',
    source: 'resourceActions',
    functionName: 'deleteTemplate',
    capability: 'templates.manage',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/templates/:id/unhide',
    source: 'resourceActions',
    functionName: 'unhideTemplate',
    capability: 'templates.manage',
    data: mergeBody,
  },

  {
    method: 'GET',
    pattern: '/api/server-finder/query',
    source: 'finder',
    functionName: 'queryServerFinder',
    capability: 'server.install',
    data: queryData('ip', 'port'),
    status: (result) => (result?.success === false ? 504 : 200),
  },
  {
    method: 'GET',
    pattern: '/api/server-finder/ping',
    source: 'finder',
    functionName: 'pingServerFinder',
    capability: 'server.install',
    data: queryData('ip', 'port'),
  },
  {
    method: 'GET',
    pattern: '/api/server-finder/debug',
    source: 'finder',
    functionName: 'getServerFinderDebug',
    capability: 'server.install',
  },
  {
    method: 'GET',
    pattern: '/api/server-finder',
    source: 'finder',
    functionName: 'getServerFinder',
    capability: 'server.install',
    data: (query) => ({ refresh: query.get('refresh') === 'true' }),
  },

  {
    method: 'GET',
    pattern: '/api/system/storage-health',
    source: 'system',
    functionName: 'getStorageHealth',
  },

  {
    method: 'GET',
    pattern: '/api/config/app-settings',
    source: 'admin',
    functionName: 'getAppSettings',
  },
  {
    method: 'PUT',
    pattern: '/api/config/app-settings',
    source: 'admin',
    functionName: 'updateAppSettings',
    capability: 'panel.settings',
  },
  {
    method: 'GET',
    pattern: '/api/config/cors-debug',
    source: 'admin',
    functionName: 'getCorsDiagnostics',
    capability: 'diagnostics.manage',
  },
  {
    method: 'POST',
    pattern: '/api/config/cors-debug/reload',
    source: 'admin',
    functionName: 'reloadCorsDiagnostics',
    capability: 'diagnostics.manage',
  },
  {
    method: 'DELETE',
    pattern: '/api/config/cors-debug/blocked',
    source: 'admin',
    functionName: 'clearCorsBlockedOrigins',
    capability: 'diagnostics.manage',
  },
  {
    method: 'POST',
    pattern: '/api/config/test-rcon',
    source: 'admin',
    functionName: 'testAppRconConnection',
    capability: 'server.configure',
  },

  {
    method: 'GET',
    pattern: '/api/backup/status',
    source: 'resources',
    functionName: 'getBackupStatus',
    anyCapability: ['backups.manage', 'backups.download', 'backups.restore'],
  },
  {
    method: 'GET',
    pattern: '/api/backup/info',
    source: 'resources',
    functionName: 'getBackupInfo',
  },
  {
    method: 'GET',
    pattern: '/api/backup/list',
    source: 'resources',
    functionName: 'getBackups',
    anyCapability: ['backups.manage', 'backups.download', 'backups.restore'],
  },
  {
    method: 'GET',
    pattern: '/api/backup/history',
    source: 'resources',
    functionName: 'getBackupHistory',
    anyCapability: ['backups.manage', 'backups.download', 'backups.restore'],
    data: queryData('limit', 'serverId'),
  },
  {
    method: 'GET',
    pattern: '/api/backup/:name/snapshot',
    source: 'resources',
    functionName: 'getBackupSnapshot',
    capability: 'backups.manage',
    data: mergeBody,
  },
  {
    method: 'GET',
    pattern: '/api/backup/download/:name',
    source: 'http',
    functionName: 'downloadBackup',
    capability: 'backups.download',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/backup/upload',
    source: 'http',
    functionName: 'uploadBackup',
    capability: 'backups.manage',
  },
  {
    method: 'POST',
    pattern: '/api/backup/settings',
    source: 'resourceActions',
    functionName: 'updateBackupSettings',
    capability: 'backups.manage',
    bodyError: {
      success: false,
      error: 'Request body must be an object',
    },
  },
  {
    method: 'POST',
    pattern: '/api/backup/create',
    source: 'resourceActions',
    functionName: 'createBackup',
    capability: 'backups.manage',
  },
  {
    method: 'DELETE',
    pattern: '/api/backup/:name',
    source: 'resourceActions',
    functionName: 'deleteBackup',
    capability: 'backups.manage',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/backup/restore/:name',
    source: 'resourceActions',
    functionName: 'restoreBackup',
    capability: 'backups.restore',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/backup/delete-older-than',
    source: 'resourceActions',
    functionName: 'deleteBackupsOlderThan',
    capability: 'backups.manage',
  },

  {
    method: 'GET',
    pattern: '/api/mods/status',
    source: 'mods',
    functionName: 'getModsStatus',
  },
  {
    method: 'GET',
    pattern: '/api/mods/tracked',
    source: 'mods',
    functionName: 'getTrackedMods',
  },
  {
    method: 'POST',
    pattern: '/api/mods/track',
    source: 'mods',
    functionName: 'trackMod',
  },
  {
    method: 'DELETE',
    pattern: '/api/mods/track/:workshopId',
    source: 'mods',
    functionName: 'untrackMod',
    data: mergeBody,
  },
  {
    method: 'GET',
    pattern: '/api/mods/ignored',
    source: 'mods',
    functionName: 'getIgnoredMods',
  },
  {
    method: 'DELETE',
    pattern: '/api/mods/ignored/:workshopId',
    source: 'mods',
    functionName: 'unignoreMod',
    data: mergeBody,
  },
  {
    method: 'DELETE',
    pattern: '/api/mods/ignored',
    source: 'mods',
    functionName: 'clearAllIgnoredMods',
  },
  {
    method: 'GET',
    pattern: '/api/mods/ignored-pairs',
    source: 'mods',
    functionName: 'getIgnoredModPairs',
  },
  {
    method: 'POST',
    pattern: '/api/mods/ignored-pairs',
    source: 'mods',
    functionName: 'addIgnoredModPair',
  },
  {
    method: 'DELETE',
    pattern: '/api/mods/ignored-pairs',
    source: 'mods',
    functionName: 'removeIgnoredModPair',
  },
  {
    method: 'GET',
    pattern: '/api/mods/server-mods',
    source: 'mods',
    functionName: 'getServerMods',
  },
  {
    method: 'POST',
    pattern: '/api/mods/start',
    source: 'mods',
    functionName: 'startModChecker',
  },
  {
    method: 'POST',
    pattern: '/api/mods/stop',
    source: 'mods',
    functionName: 'stopModChecker',
  },
  {
    method: 'POST',
    pattern: '/api/mods/auto-restart',
    source: 'mods',
    functionName: 'setModAutoRestart',
  },
  {
    method: 'PUT',
    pattern: '/api/mods/restart-options',
    source: 'mods',
    functionName: 'setModRestartOptions',
  },
  {
    method: 'GET',
    pattern: '/api/mods/workshop-status',
    source: 'mods',
    functionName: 'getWorkshopStatus',
  },
  {
    method: 'POST',
    pattern: '/api/mods/cancel-pending-restart',
    source: 'mods',
    functionName: 'cancelPendingModRestart',
  },
  {
    method: 'GET',
    pattern: '/api/mods/presets',
    source: 'mods',
    functionName: 'getModPresets',
  },
  {
    method: 'PUT',
    pattern: '/api/mods/presets/:id',
    source: 'mods',
    functionName: 'updateModPreset',
    data: mergeBody,
  },
  {
    method: 'DELETE',
    pattern: '/api/mods/presets/:id',
    source: 'mods',
    functionName: 'deleteModPreset',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/mods/collection/items',
    source: 'mods',
    functionName: 'addCollectionItem',
  },
  {
    method: 'DELETE',
    pattern: '/api/mods/collection/items/:workshopId',
    source: 'mods',
    functionName: 'removeCollectionItem',
    data: mergeBody,
  },
  {
    method: 'DELETE',
    pattern: '/api/mods/collection/tracking/:workshopId',
    source: 'mods',
    functionName: 'removeCollectionTracking',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/mods/collection/save-cookies',
    source: 'mods',
    functionName: 'saveCollectionCookies',
  },

  {
    method: 'GET',
    pattern: '/api/server-files/paths',
    source: 'fileReads',
    functionName: 'getServerFilePaths',
  },
  {
    method: 'GET',
    pattern: '/api/server-files/image-preview',
    source: 'http',
    functionName: 'previewServerImage',
    capability: 'serverfiles.manage',
    data: queryData('path'),
  },
  {
    method: 'GET',
    pattern: '/api/server-files/ini',
    source: 'fileReads',
    functionName: 'getServerIni',
  },
  {
    method: 'GET',
    pattern: '/api/server-files/sandbox',
    source: 'fileReads',
    functionName: 'getServerSandbox',
  },
  {
    method: 'GET',
    pattern: '/api/server-files/sandbox/validate',
    source: 'fileReads',
    functionName: 'validateServerSandbox',
  },
  {
    method: 'GET',
    pattern: '/api/server-files/spawnpoints',
    source: 'fileReads',
    functionName: 'getServerSpawnPoints',
  },
  {
    method: 'GET',
    pattern: '/api/server-files/spawnregions',
    source: 'fileReads',
    functionName: 'getServerSpawnRegions',
  },
  {
    method: 'GET',
    pattern: '/api/server-files/raw/:type',
    source: 'fileReads',
    functionName: 'getServerRawFile',
    data: mergeBody,
  },
  {
    method: 'GET',
    pattern: '/api/server-files/backups',
    source: 'fileReads',
    functionName: 'getServerConfigBackups',
  },
  {
    method: 'GET',
    pattern: '/api/server-files/templates',
    source: 'fileReads',
    functionName: 'getConfigTemplates',
  },
  {
    method: 'GET',
    pattern: '/api/server-files/templates/:id',
    source: 'fileReads',
    functionName: 'getConfigTemplate',
    data: mergeBody,
  },
  {
    method: 'GET',
    pattern: '/api/server-files/browse-files',
    source: 'fileReads',
    functionName: 'browseServerFiles',
    data: queryData('path', 'extensions'),
  },
  {
    method: 'PUT',
    pattern: '/api/server-files/ini',
    source: 'fileWrites',
    functionName: 'saveServerIni',
  },
  {
    method: 'PUT',
    pattern: '/api/server-files/sandbox',
    source: 'fileWrites',
    functionName: 'saveServerSandbox',
  },
  {
    method: 'PUT',
    pattern: '/api/server-files/sandbox-option',
    source: 'fileWrites',
    functionName: 'saveSandboxOption',
  },
  {
    method: 'POST',
    pattern: '/api/server-files/sandbox/repair',
    source: 'fileWrites',
    functionName: 'repairServerSandbox',
  },
  {
    method: 'PUT',
    pattern: '/api/server-files/spawnpoints',
    source: 'fileWrites',
    functionName: 'saveServerSpawnPoints',
  },
  {
    method: 'PUT',
    pattern: '/api/server-files/spawnregions',
    source: 'fileWrites',
    functionName: 'saveServerSpawnRegions',
  },
  {
    method: 'PUT',
    pattern: '/api/server-files/raw/:type',
    source: 'fileWrites',
    functionName: 'saveServerRawFile',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/server-files/restore/:filename',
    source: 'fileWrites',
    functionName: 'restoreServerConfigBackup',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/server-files/save-and-reload',
    source: 'fileWrites',
    functionName: 'saveServerAndReload',
  },
  {
    method: 'POST',
    pattern: '/api/server-files/templates',
    source: 'fileWrites',
    functionName: 'createServerConfigTemplate',
  },
  {
    method: 'POST',
    pattern: '/api/server-files/templates/:id/apply',
    source: 'fileWrites',
    functionName: 'applyServerConfigTemplate',
    data: mergeBody,
  },
  {
    method: 'PUT',
    pattern: '/api/server-files/templates/:id',
    source: 'fileWrites',
    functionName: 'updateServerConfigTemplate',
    data: mergeBody,
  },
  {
    method: 'DELETE',
    pattern: '/api/server-files/templates/:id',
    source: 'fileWrites',
    functionName: 'deleteServerConfigTemplate',
    data: mergeBody,
  },

  {
    method: 'GET',
    pattern: '/api/debug/ram',
    source: 'admin',
    functionName: 'getDebugRam',
    capability: 'diagnostics.manage',
  },
  {
    method: 'GET',
    pattern: '/api/debug/performance-history',
    source: 'admin',
    functionName: 'getPerformanceHistory',
    capability: 'diagnostics.manage',
    data: performanceHistoryData,
  },

  {
    method: 'GET',
    pattern: '/api/auth/status',
    source: 'auth',
    functionName: 'getAuthStatus',
    public: true,
  },
  {
    method: 'POST',
    pattern: '/api/auth/setup',
    source: 'auth',
    functionName: 'setup',
    public: true,
    status: 201,
  },
  {
    method: 'POST',
    pattern: '/api/auth/login',
    source: 'auth',
    functionName: 'login',
    public: true,
  },
  {
    method: 'POST',
    pattern: '/api/auth/refresh',
    source: 'auth',
    functionName: 'refresh',
    public: true,
  },
  {
    method: 'POST',
    pattern: '/api/auth/logout',
    source: 'auth',
    functionName: 'logout',
    public: true,
  },
  {
    method: 'GET',
    pattern: '/api/auth/reset-status',
    source: 'auth',
    functionName: 'resetStatus',
    public: true,
  },
  {
    method: 'POST',
    pattern: '/api/auth/reset-token/local',
    source: 'auth',
    functionName: 'createLocalResetToken',
    public: true,
  },
  {
    method: 'POST',
    pattern: '/api/auth/reset-password',
    source: 'auth',
    functionName: 'resetPassword',
    public: true,
  },
  {
    method: 'POST',
    pattern: '/api/auth/recover-with-code',
    source: 'auth',
    functionName: 'recoverWithCode',
    public: true,
  },
  {
    method: 'GET',
    pattern: '/api/auth/me',
    source: 'auth',
    functionName: 'getCurrentUser',
  },
  {
    method: 'POST',
    pattern: '/api/auth/change-password',
    source: 'admin',
    functionName: 'changePassword',
    data: mergeBody,
  },
  {
    method: 'GET',
    pattern: '/api/auth/users',
    source: 'admin',
    functionName: 'getManagedUsers',
    capability: 'users.manage',
  },
  {
    method: 'POST',
    pattern: '/api/auth/users',
    source: 'admin',
    functionName: 'createManagedUser',
    capability: 'users.manage',
    status: 201,
  },
  {
    method: 'PATCH',
    pattern: '/api/auth/users/:id/role',
    source: 'admin',
    functionName: 'assignManagedUserRole',
    capability: 'users.manage',
    data: (_query, body, params) => ({
      ...body,
      userId: params.id,
    }),
  },
  {
    method: 'DELETE',
    pattern: '/api/auth/users/:id',
    source: 'admin',
    functionName: 'removeManagedUser',
    capability: 'users.manage',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/auth/regenerate-jwt-secret',
    source: 'admin',
    functionName: 'regenerateJwtSecret',
    role: 'admin',
  },
  {
    method: 'GET',
    pattern: '/api/auth/recovery-codes',
    source: 'admin',
    functionName: 'getRecoveryCodes',
    role: 'admin',
  },
  {
    method: 'POST',
    pattern: '/api/auth/recovery-codes',
    source: 'admin',
    functionName: 'generateRecoveryCodes',
    role: 'admin',
  },
  {
    method: 'GET',
    pattern: '/api/auth/recovery-status',
    source: 'auth',
    functionName: 'getRecoveryStatus',
    public: true,
  },
  {
    method: 'GET',
    pattern: '/api/auth/oidc/status',
    source: 'auth',
    functionName: 'getOidcStatus',
    public: true,
  },
  {
    method: 'GET',
    pattern: '/api/auth/oidc/login',
    source: 'http',
    functionName: 'oidcLogin',
    public: true,
  },
  {
    method: 'GET',
    pattern: '/api/auth/oidc/callback',
    source: 'http',
    functionName: 'oidcCallback',
    public: true,
  },
  {
    method: 'GET',
    pattern: '/api/auth/oidc/settings',
    source: 'admin',
    functionName: 'getOidcSettings',
    capability: 'panel.settings',
  },
  {
    method: 'PUT',
    pattern: '/api/auth/oidc/settings',
    source: 'admin',
    functionName: 'updateOidcSettings',
    capability: 'panel.settings',
    data: mergeBody,
  },
  {
    method: 'POST',
    pattern: '/api/auth/oidc/test-connection',
    source: 'admin',
    functionName: 'testOidcConnection',
    capability: 'panel.settings',
    data: mergeBody,
  },
]

async function readBody(request: Request): Promise<ParsedBody> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return { value: {}, isObject: false }
  }
  const contentType = request.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return { value: {}, isObject: false }
  }
  const text = await request.text()
  if (!text.trim()) return { value: {}, isObject: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw Object.assign(new Error('Invalid JSON request body'), {
      status: 400,
      code: 'AUTH_REQUEST_INVALID',
    })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: {}, isObject: false }
  }
  return { value: parsed as AnyRecord, isObject: true }
}

function requiredCapabilities(capability?: string | string[]): string[] {
  if (!capability) return []
  return Array.isArray(capability) ? capability : [capability]
}

function errorDetails(error: unknown): AnyRecord {
  return error && typeof error === 'object' ? (error as AnyRecord) : {}
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  const details = errorDetails(error)
  if (typeof details.error === 'string') return details.error
  if (typeof details.message === 'string') return details.message
  return String(error)
}

function errorResponse(error: unknown): Response {
  const details = errorDetails(error)
  const status =
    typeof details.status === 'number' && details.status >= 400
      ? details.status
      : 500
  const body: AnyRecord = {
    error: sanitizeError(errorMessage(error)),
  }
  if (typeof details.code === 'string') body.code = details.code
  if (details.success === false) body.success = false
  if (details.valid === false) body.valid = false
  if (typeof details.detail === 'string') {
    body.detail = sanitizeError(details.detail)
  }
  if (typeof details.reason === 'string') {
    body.reason = sanitizeError(details.reason)
  }
  if (details.params !== undefined) {
    body.params = sanitizeErrorParams(details.params)
  }
  if (Array.isArray(details.missing)) body.missing = details.missing
  if (Array.isArray(details.partiallyApplied)) {
    body.partiallyApplied = details.partiallyApplied
  }
  return Response.json(body, { status })
}

function markStartHandled(response: Response): Response {
  response.headers.set(START_HANDLED_HEADER, '1')
  return response
}

async function authenticate(
  request: Request,
): Promise<AuthenticatedUser | Response> {
  let authService: any
  try {
    const { getPanelRuntime } =
      await import('../../../panel-server/utils/panelRuntime.ts')
    authService = getPanelRuntime().authService
  } catch {
    // Isolated compatibility tests do not boot the panel runtime.
  }
  authService ??= (await import('../../../panel-server/services/auth.ts')).default
  const token = new URL(request.url).searchParams.get('token')
  const result = await authService.authenticateApiRequest(
    request.headers.get('authorization') ?? (token ? `Bearer ${token}` : null),
  )
  if (!result.ok) {
    return Response.json(
      { error: result.error, code: result.code },
      { status: result.status },
    )
  }
  return result.user
}

async function canAccess(
  user: AuthenticatedUser,
  capability?: string | string[],
  anyCapability?: string[],
): Promise<boolean> {
  const required = requiredCapabilities(capability)
  if (required.length === 0 && !anyCapability?.length) return true
  const { getCapabilitiesForRole } =
    await import('../../../panel-server/services/permissions.ts')
  const capabilities = await getCapabilitiesForRole(user.role)
  return (
    required.every((item) => capabilities?.includes(item)) &&
    (!anyCapability?.length ||
      anyCapability.some((item) => capabilities?.includes(item)))
  )
}

async function execute(
  spec: RouteSpec,
  data: AnyRecord,
  user: AuthenticatedUser | null,
  request: Request,
): Promise<unknown> {
  const implementation = await implementations[spec.source]()
  const serverFunction = implementation[spec.functionName] as unknown as
    ServerFunction | undefined
  if (typeof serverFunction === 'function') {
    return serverFunction.__executeImplementation
      ? serverFunction.__executeImplementation(data, {
          authenticatedUser: user,
        })
      : serverFunction(data, { authenticatedUser: user, request })
  }
  if (serverFunction?.__executeImplementation) {
    return serverFunction.__executeImplementation(data, {
      authenticatedUser: user,
    })
  }
  if (!serverFunction?.__executeServer) {
    throw new Error(`Server function ${spec.functionName} is not available`)
  }
  const outcome = await serverFunction.__executeServer({
    data,
    context: { authenticatedUser: user },
  })
  if (outcome.error) throw outcome.error
  return outcome.result
}

export async function handleStartApiCompatibilityRequest(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url)
  const method =
    request.method.toUpperCase() === 'HEAD'
      ? 'GET'
      : request.method.toUpperCase()
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  const spec = routes.find(
    (candidate) =>
      candidate.method === method && matchPattern(candidate.pattern, pathname),
  )
  if (!spec) {
    const { handleStartApiRequest } =
      await import('../../../panel-server/http/startApiDispatcher.ts')
    const response = await handleStartApiRequest(request)
    return markStartHandled(
      response || Response.json({ error: 'API endpoint not found' }, { status: 404 }),
    )
  }

  try {
    const authenticated = spec.public ? null : await authenticate(request)
    if (authenticated instanceof Response)
      return markStartHandled(authenticated)
    if (authenticated && spec.role && authenticated.role !== spec.role) {
      return markStartHandled(
        Response.json(
          { error: 'Insufficient permissions', code: 'PERMISSION_DENIED' },
          { status: 403 },
        ),
      )
    }
    if (
      authenticated &&
      !(await canAccess(
        authenticated,
        spec.capability ?? sourceCapabilities[spec.source],
        spec.anyCapability,
      ))
    ) {
      return markStartHandled(
        Response.json(
          { error: 'Insufficient permissions', code: 'PERMISSION_DENIED' },
          { status: 403 },
        ),
      )
    }

    const parsedBody = await readBody(request)
    if (spec.bodyError && !parsedBody.isObject) {
      return markStartHandled(Response.json(spec.bodyError, { status: 400 }))
    }
    const body = parsedBody.value
    const params = matchPattern(spec.pattern, pathname) || {}
    const data = spec.data
      ? spec.data(url.searchParams, body, params)
      : mergeBody(url.searchParams, body, params)
    const result = await execute(spec, data, authenticated, request)
    if (result instanceof Response) return markStartHandled(result)
    const status =
      typeof spec.status === 'function'
        ? spec.status(result)
        : spec.status || 200
    const headers = spec.headers?.(params)
    if (result === undefined) {
      return markStartHandled(new Response(null, { status, headers }))
    }
    return markStartHandled(Response.json(result, { status, headers }))
  } catch (error) {
    return markStartHandled(errorResponse(error))
  }
}
