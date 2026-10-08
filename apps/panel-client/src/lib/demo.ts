const DEMO_FLAGS = new Set(['1', 'true', 'yes', 'on'])

export function isDemoMode(): boolean {
  const value = (import.meta.env.VITE_DEMO_MODE || '').toString().trim().toLowerCase()
  return DEMO_FLAGS.has(value)
}

let demoFetchInstalled = false

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

function normalizeApiPath(input: RequestInfo | URL): string {
  const rawUrl = typeof input === 'string'
    ? input
    : input instanceof URL
    ? input.toString()
    : input.url

  try {
    const parsed = new URL(rawUrl, window.location.origin)
    const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
    if (basePath && parsed.pathname.startsWith(`${basePath}/api/`)) {
      return parsed.pathname.slice(basePath.length)
    }

    const apiIndex = parsed.pathname.indexOf('/api/')
    if (apiIndex >= 0) {
      return parsed.pathname.slice(apiIndex).replace(/^\/api\/servers\/[^/]+\/(rcon|server|players|mods|server-files|debug|backup|map|config|docker|scheduler|system|game-integration)(\/.*)?$/, "/api/$1$2")
    }

    return parsed.pathname
  } catch {
    const apiIndex = rawUrl.indexOf('/api/')
    return apiIndex >= 0 ? rawUrl.slice(apiIndex) : rawUrl
  }
}

const demoTimestamp = '2026-06-24T02:00:00.000Z'

const demoTrackedMods = [
  {
    id: 1,
    workshop_id: '2392709985',
    name: 'Tsar\'s Common Library 2.0',
    last_updated: '2026-06-23T20:15:00.000Z',
    last_checked: demoTimestamp,
    update_available: 0,
    created_at: '2026-05-18T12:00:00.000Z',
    active: true,
  },
  {
    id: 2,
    workshop_id: '2169435993',
    name: 'Brita\'s Weapon Pack',
    last_updated: '2026-06-24T01:10:00.000Z',
    last_checked: demoTimestamp,
    update_available: 1,
    created_at: '2026-05-18T12:05:00.000Z',
    active: true,
  },
  {
    id: 3,
    workshop_id: '2004998206',
    name: 'Raven Creek',
    last_updated: '2026-06-20T09:30:00.000Z',
    last_checked: demoTimestamp,
    update_available: 0,
    created_at: '2026-05-18T12:10:00.000Z',
    active: true,
  },
  {
    id: 4,
    workshop_id: '2849247394',
    name: 'Authentic Z',
    last_updated: '2026-06-18T15:45:00.000Z',
    last_checked: demoTimestamp,
    update_available: 0,
    created_at: '2026-05-18T12:15:00.000Z',
    active: true,
  },
  {
    id: 5,
    workshop_id: '3000000003',
    name: 'Expanded Helicopter Events',
    last_updated: '2026-06-12T08:10:00.000Z',
    last_checked: demoTimestamp,
    update_available: 0,
    created_at: '2026-05-25T14:00:00.000Z',
    active: false,
  },
]

const demoWorkshopModMap = {
  '2392709985': [{ id: 'TchernoLib', name: 'Tsar\'s Common Library 2.0', enabled: true }],
  '2169435993': [{ id: 'Brita', name: 'Brita\'s Weapon Pack', enabled: true, require: ['TchernoLib', 'Arsenal(26)GunFighter'] }],
  '2004998206': [{ id: 'RavenCreek', name: 'Raven Creek', enabled: true }],
  '2849247394': [
    { id: 'AuthenticZLite', name: 'Authentic Z Lite', enabled: true },
    { id: 'AuthenticZBackpacks', name: 'Authentic Z Backpacks', enabled: false },
  ],
}

function demoModsStatus() {
  return {
    totalModsTracked: demoTrackedMods.length,
    totalModsInWorkshop: 7,
    updatesAvailable: 1,
    lastCheck: demoTimestamp,
    lastUpdateDetected: '2026-06-24T01:20:00.000Z',
    autoRestartEnabled: true,
    running: false,
    workshopAcfConfigured: true,
    workshopAcfPath: '/opt/pz/steamapps/workshop/appworkshop_108600.acf',
    checkInterval: 30,
    modsNeedingUpdate: [
      {
        workshopId: '2169435993',
        name: 'Brita\'s Weapon Pack',
        localTimestamp: '2026-06-23T11:30:00.000Z',
        latestTimestamp: '2026-06-24T01:10:00.000Z',
      },
    ],
    restartWarningMinutes: 15,
    forceAfterDeadline: false,
    maxDelayMinutes: 60,
    pendingRestart: false,
  }
}

function demoCurrentConfig() {
  const workshopIds = demoTrackedMods.filter(mod => mod.active !== false).map(mod => mod.workshop_id)
  const modIds = ['TchernoLib', 'Brita', 'RavenCreek', 'AuthenticZLite']
  return {
    configured: true,
    modIds,
    workshopIds,
    maps: ['Muldraugh, KY', 'RavenCreek'],
    totalMods: modIds.length,
    iniPath: '/home/pz/Zomboid/Server/DoomerZDemo.ini',
    workshopModMap: demoWorkshopModMap,
  }
}

function demoConflictScan() {
  return {
    totalConflicts: 3,
    identicalSkipped: 14,
    additiveSkipped: 6,
    pzAdditiveSkipped: 4,
    pzAdditiveBreakdown: {
      sandbox: 1,
      scripts: 2,
      clothing: 1,
      fileguidtable: 0,
      translate: 0,
    },
    totalPairs: 2,
    modsScanned: 4,
    modsNotFound: 0,
    modsSkippedInactive: 1,
    totalWorkshopIds: demoCurrentConfig().workshopIds.length,
    modLoadOrder: ['TchernoLib', 'Brita', 'RavenCreek', 'AuthenticZLite'],
    warnings: ['Demo scan uses static sample data. Run a real scan from a connected panel to inspect your server files.'],
    scanDurationMs: 1834,
    missingDeps: [
      {
        modId: 'Brita',
        modName: 'Brita\'s Weapon Pack',
        workshopId: '2169435993',
        missingDep: 'Arsenal(26)GunFighter',
        resolvedWorkshopId: '2297098490',
        resolvedModName: 'Arsenal GunFighter',
      },
    ],
    steamDeps: [
      {
        parentWorkshopId: '2169435993',
        parentName: 'Brita\'s Weapon Pack',
        childWorkshopId: '2297098490',
        childName: 'Arsenal GunFighter',
        source: 'steam',
      },
    ],
    idCollisions: [
      {
        modId: 'AuthenticZLite',
        active: true,
        sources: [
          { workshopId: '2849247394', modName: 'Authentic Z', active: true },
          { workshopId: '3000000001', modName: 'Authentic Z Mirror', active: false },
        ],
      },
    ],
    pairs: [
      {
        modA: { workshopId: '2169435993', modId: 'Brita', modName: 'Brita\'s Weapon Pack' },
        modB: { workshopId: '2849247394', modId: 'AuthenticZLite', modName: 'Authentic Z Lite' },
        highCount: 1,
        mediumCount: 1,
        lowCount: 0,
        aWins: 1,
        bWins: 1,
        thirdPartyWins: 0,
        unknownWins: 0,
        files: [
          {
            file: 'media/scripts/clothing/demo_vests.txt',
            category: 'scripts',
            categoryLabel: 'Script definitions',
            severity: 'high',
            winner: { workshopId: '2849247394', modId: 'AuthenticZLite', modName: 'Authentic Z Lite' },
            overlap: { kind: 'script-defs', items: ['Base.PoliceVest', 'Base.HolsterDouble'], total: 2 },
          },
          {
            file: 'media/lua/shared/Items/demo_distribution.lua',
            category: 'lua',
            categoryLabel: 'Lua scripts',
            severity: 'medium',
            winner: { workshopId: '2169435993', modId: 'Brita', modName: 'Brita\'s Weapon Pack' },
            overlap: { kind: 'lua-symbols', items: ['OnFillContainer', 'ProceduralDistributions.list.PoliceStorage'], total: 2 },
          },
        ],
      },
      {
        modA: { workshopId: '2392709985', modId: 'TchernoLib', modName: 'Tsar\'s Common Library 2.0' },
        modB: { workshopId: '2169435993', modId: 'Brita', modName: 'Brita\'s Weapon Pack' },
        highCount: 0,
        mediumCount: 0,
        lowCount: 1,
        aWins: 0,
        bWins: 1,
        thirdPartyWins: 0,
        unknownWins: 0,
        files: [
          {
            file: 'media/lua/shared/demo_patch.lua',
            category: 'lua',
            categoryLabel: 'Lua scripts',
            severity: 'low',
            winner: { workshopId: '2169435993', modId: 'Brita', modName: 'Brita\'s Weapon Pack' },
            overlap: { kind: 'lua-shadow', items: [], total: 0 },
          },
        ],
      },
    ],
    stale: false,
    _workshopIdsSnapshot: demoCurrentConfig().workshopIds,
    _modIdsSnapshot: ['TchernoLib', 'Brita', 'RavenCreek', 'AuthenticZLite'],
  }
}

function demoCollectionDiff() {
  return {
    ok: true,
    title: 'DoomerZ Demo Collection',
    inCollection: ['2392709985', '2169435993', '2004998206', '3000000002'],
    toAdd: ['2849247394', '3000000003'],
    toRemove: ['3000000002'],
    items: [
      { workshopId: '2392709985', name: 'Tsar\'s Common Library 2.0', status: 'synced', inTracked: true, inCollection: true },
      { workshopId: '2169435993', name: 'Brita\'s Weapon Pack', status: 'synced', inTracked: true, inCollection: true },
      { workshopId: '2004998206', name: 'Raven Creek', status: 'synced', inTracked: true, inCollection: true },
      { workshopId: '2849247394', name: 'Authentic Z', status: 'to-add', inTracked: true, inCollection: false },
      { workshopId: '3000000003', name: 'Expanded Helicopter Events', status: 'to-add', inTracked: true, inCollection: false },
      { workshopId: '3000000002', name: 'Legacy Vehicle Pack', status: 'to-remove', inTracked: false, inCollection: true },
    ],
    collectionId: '3001234567',
    trackedCount: demoTrackedMods.length,
  }
}

function demoWorkshopSearch(query: string) {
  const trimmed = query.trim()
  const lower = trimmed.toLowerCase()
  const arsenal = lower.includes('arsenal') || lower.includes('gunfighter')
  const tomb = lower.includes('tomb') || lower === 'tombbody'
  const results = arsenal
    ? [
        {
          workshopId: '2297098490',
          modId: 'Arsenal(26)GunFighter',
          modName: 'Arsenal GunFighter',
          description: 'Required framework for several weapon packs.',
          subscriberCount: 1260000,
          source: 'local',
          isDownloaded: true,
          matchedVariant: trimmed,
          relevance: 120,
        },
      ]
    : tomb
    ? [
        {
          workshopId: '2997342681',
          modId: 'TombBody',
          modName: "Tomb's Player Body",
          description: 'Exact internal mod ID match from local workshop metadata.',
          subscriberCount: 84000,
          source: 'local',
          isDownloaded: true,
          matchedVariant: trimmed,
          relevance: 140,
        },
      ]
    : [
        {
          workshopId: '2392709985',
          modId: 'TchernoLib',
          modName: 'Tsar\'s Common Library 2.0',
          description: 'Local demo result matched from downloaded metadata.',
          subscriberCount: 990000,
          source: 'local',
          isDownloaded: true,
          matchedVariant: trimmed,
          relevance: 80,
        },
      ]

  return {
    success: true,
    query: trimmed,
    variantsTried: [trimmed].filter(Boolean),
    steamSearchEnabled: false,
    steamSearchAttempted: false,
    results,
    searchUrl: `https://steamcommunity.com/workshop/browse/?appid=108600&searchtext=${encodeURIComponent(trimmed)}`,
  }
}

async function readJsonBody(init?: RequestInit): Promise<Record<string, unknown>> {
  if (!init?.body || typeof init.body !== 'string') return {}
  try {
    const value = JSON.parse(init.body)
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function demoServer() {
  return {
    id: 'demo-server',
    name: 'Demo Server',
    serverName: 'DoomerZDemo',
    installPath: '/opt/pz',
    zomboidDataPath: '/home/pz/Zomboid',
    serverConfigPath: '/home/pz/Zomboid/Server',
    rconHost: '127.0.0.1',
    rconPort: 27015,
    rconPassword: '••••••••',
    serverPort: 16261,
    minMemory: 2,
    maxMemory: 4,
    useNoSteam: false,
    useDebug: false,
    isActive: true,
    createdAt: new Date().toISOString(),
  }
}

function demoIniSettings(): Record<string, string> {
  return {
    PublicName: 'Demo Server',
    PublicDescription: 'GitHub Pages demo mode (no backend connection)',
    MaxPlayers: '16',
    PauseEmpty: 'true',
    Open: 'true',
    PVP: 'false',
    RCONPort: '27015',
    RCONPassword: 'demo-password',
    Mods: 'DemoMod1;DemoMod2',
    WorkshopItems: '1234567890;0987654321',
    DoLuaChecksum: 'false',
  }
}

function demoStorageHealth() {
  return {
    diskSpace: {
      saveVolume: null,
      panelData: {
        path: null,
        totalBytes: 0,
        freeBytes: 0,
        usedPercent: 0,
        warning: false,
        critical: false,
      },
    },
    database: { ok: true, error: null },
  }
}

const DEMO_UPTIME_SECONDS = 3 * 3600 + 12 * 60
const DEMO_PLAYERS = ['Kate', 'Baldspot', 'nightowl_92', 'Marisol']

function demoServerStatus() {
  return {
    running: true,
    state: 'ready',
    startTime: new Date(Date.now() - DEMO_UPTIME_SECONDS * 1000).toISOString(),
    uptime: DEMO_UPTIME_SECONDS,
    serverPath: '/opt/pz',
    serverPathConfigured: true,
    configured: true,
    localIp: '192.168.1.20',
    publicIp: '203.0.113.24',
    port: 16261,
    rcon: { host: '127.0.0.1', port: 27015, connected: true },
  }
}

function demoComposedStatus() {
  return {
    provider: 'native',
    selected: true,
    state: 'ready',
    host: { status: 'running', label: 'Process', detail: null },
    server: { status: 'connected', label: 'RCON', detail: null },
    gameIntegration: { status: 'active', label: 'Game integration', detail: null },
    summary: 'Demo server is running',
  }
}

/** One sample a minute, like the real panel, with a smooth daily curve. */
function demoPerformanceHistory(limit: number) {
  const now = Date.now()
  const GB = 1024 ** 3
  return Array.from({ length: limit }, (_, index) => {
    const minutesAgo = limit - 1 - index
    const wave = Math.sin((now / 60_000 - minutesAgo) / 90)
    const players = Math.max(0, Math.round(3 + wave * 3 + Math.sin(minutesAgo / 7)))
    return {
      timestamp: new Date(now - minutesAgo * 60_000).toISOString(),
      playerCount: players,
      cpuUsage: 18 + players * 4 + Math.abs(Math.sin(minutesAgo / 3)) * 6,
      pzMemUsed: (2.2 + players * 0.18 + wave * 0.1) * GB,
      memoryUsed: 180 * 1024 ** 2,
      hostMemUsed: (9.4 + players * 0.2) * GB,
      hostMemTotal: 16 * GB,
      hostDiskUsed: 182 * GB,
      hostDiskTotal: 256 * GB,
      hostSwapUsed: 0.2 * GB,
      hostSwapTotal: 2 * GB,
    }
  })
}

function demoActivity() {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
  return [
    { id: 8, player_name: 'Marisol', action: 'connect', details: null, logged_at: at(4) },
    { id: 7, player_name: 'Baldspot', action: 'death', details: null, logged_at: at(19) },
    { id: 6, player_name: 'nightowl_92', action: 'connect', details: null, logged_at: at(41) },
    { id: 5, player_name: 'Rook', action: 'disconnect', details: null, logged_at: at(58) },
    { id: 4, player_name: 'Baldspot', action: 'connect', details: null, logged_at: at(96) },
    { id: 3, player_name: 'GrieferJoe', action: 'kick', details: 'Spawn camping', logged_at: at(130) },
    { id: 2, player_name: 'Kate', action: 'connect', details: null, logged_at: at(171) },
  ]
}

function demoConsoleLog() {
  const t = (minutesAgo: number) => Date.now() - minutesAgo * 60_000
  return [
    `LOG  : General      f:0, t:${t(192)}> Loading world DoomerZDemo`,
    `LOG  : Network      f:0, t:${t(191)}> RCON: listening on port 27015`,
    `LOG  : General      f:0, t:${t(190)}> *** SERVER STARTED ****`,
    `LOG  : General      f:0, t:${t(171)}> ConnectionManager: [fully-connected] "Kate"`,
    `LOG  : General      f:0, t:${t(140)}> moveZombie: There are no zombies in the cell`,
    `WARN : Mod          f:0, t:${t(131)}> Brita: missing translation for item Base.M4A1`,
    `LOG  : General      f:0, t:${t(130)}> kicked user GrieferJoe (Spawn camping)`,
    `LOG  : General      f:0, t:${t(96)}> ConnectionManager: [fully-connected] "Baldspot"`,
    `ERROR: General      f:0, t:${t(62)}> java.lang.NullPointerException: Cannot invoke "zombie.inventory.InventoryItem.getType()"`,
    '    at zombie.inventory.ItemContainer.getItemCount(ItemContainer.java:1203)',
    `LOG  : General      f:0, t:${t(41)}> ConnectionManager: [fully-connected] "nightowl_92"`,
    `LOG  : General      f:0, t:${t(30)}> Saving world... done in 812 ms`,
    `LOG  : General      f:0, t:${t(4)}> ConnectionManager: [fully-connected] "Marisol"`,
  ]
}

function demoPlayerDetails(username: string, index: number) {
  return {
    username,
    displayName: username,
    x: 10580 + index * 37,
    y: 9720 - index * 21,
    z: index === 2 ? 1 : 0,
    accessLevel: index === 0 ? 'admin' : 'none',
    isAlive: true,
    isAsleep: false,
    isSneaking: index === 3,
    isRunning: index === 1,
    godMod: index === 0,
    invisible: false,
    noclip: false,
    stats: { hunger: 0.18 + index * 0.1, thirst: 0.3, fatigue: 0.12 * index, stress: 0.05, boredom: 0.2, unhappiness: 0.1, pain: 0, endurance: 0.92 },
    health: { overallBodyHealth: [100, 74, 41, 88][index] ?? 90, isInfected: index === 2, isBleeding: false, temperature: 36.8 },
  }
}

function demoPlayerStats() {
  const day = 86_400_000
  const stat = (name: string, hours: number, sessions: number, lastSeenDaysAgo: number, deaths: number) => ({
    player_name: name,
    total_playtime_seconds: hours * 3600,
    session_count: sessions,
    first_seen: new Date(Date.now() - 40 * day).toISOString(),
    last_seen: new Date(Date.now() - lastSeenDaysAgo * day).toISOString(),
    deaths,
    sessions: Array.from({ length: Math.min(4, sessions) }, (_, index) => {
      const start = Date.now() - (lastSeenDaysAgo + index * 2) * day - 3 * 3600_000
      return { start: new Date(start).toISOString(), end: new Date(start + 2.5 * 3600_000).toISOString(), duration_seconds: 9000 }
    }),
  })
  return [
    stat('Kate', 212, 64, 0, 3),
    stat('Baldspot', 96, 41, 0, 9),
    stat('nightowl_92', 51, 22, 0, 2),
    stat('Marisol', 18, 7, 0, 1),
    stat('Rook', 140, 55, 0.04, 6),
    stat('GrieferJoe', 4, 3, 0.1, 0),
    stat('Tamsin', 77, 30, 3, 4),
    stat('old_hank', 230, 90, 12, 11),
  ]
}

function queryParam(input: RequestInfo | URL, name: string): string | null {
  const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  try {
    return new URL(rawUrl, window.location.origin).searchParams.get(name)
  } catch {
    return null
  }
}

export function installDemoFetchShim(): void {
  if (!isDemoMode() || demoFetchInstalled) return

  const originalFetch = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = normalizeApiPath(input)
    if (!path.startsWith('/api/')) {
      return originalFetch(input, init)
    }

    const method = (init?.method || 'GET').toUpperCase()

    if (path === '/api/auth/status') {
      return jsonResponse({ needsSetup: false, authEnabled: false })
    }
    if (path === '/api/health') {
      return jsonResponse({
        version: `${(typeof __PANEL_VERSION__ !== 'undefined' ? __PANEL_VERSION__ : '0.0.0')}-demo`,
        panelVersion: typeof __PANEL_VERSION__ !== 'undefined' ? __PANEL_VERSION__ : '0.0.0',
        buildSha: typeof __PANEL_BUILD_SHA__ !== 'undefined' ? __PANEL_BUILD_SHA__ : 'unknown',
        apiContractVersion: typeof __PANEL_API_CONTRACT_VERSION__ !== 'undefined' ? __PANEL_API_CONTRACT_VERSION__ : 1,
      })
    }
    if (path === '/api/system/storage-health') {
      return jsonResponse(demoStorageHealth())
    }
    if (path === '/api/system/runtime') {
      return jsonResponse({
        platform: 'linux',
        family: 'posix',
        pathSeparator: '/',
        temporaryDirectory: '/tmp',
        serviceManager: 'none',
        restartAssessment: {
          gameServers: 'preserved',
          requiresConfirmation: false,
          reason: 'detached-linux-process',
        },
      })
    }
    if (path === '/api/server/status') {
      return jsonResponse(demoServerStatus())
    }
    if (/^\/api\/servers\/[^/]+\/status$/.test(path)) {
      return jsonResponse(demoComposedStatus())
    }
    if (path === '/api/players') {
      return jsonResponse({ players: DEMO_PLAYERS.map((name) => ({ name, online: true })) })
    }
    if (path === '/api/server/console-log') {
      return jsonResponse({ lines: demoConsoleLog(), size: 4096, exists: true, path: '/home/pz/Zomboid/server-console.txt' })
    }
    if (path === '/api/server/console-log/stream') {
      return jsonResponse({ newLines: [], currentSize: 4096, rotated: false })
    }
    if (path === '/api/config/test-rcon') {
      return jsonResponse({ success: true, connected: true })
    }
    if (path === '/api/rcon/history') {
      return jsonResponse({
        history: [
          { id: 3, command: 'players', response: 'Players connected (4): -Kate -Baldspot -nightowl_92 -Marisol', success: 1, executed_at: new Date(Date.now() - 300_000).toISOString() },
          { id: 2, command: 'save', response: 'World saved', success: 1, executed_at: new Date(Date.now() - 1_800_000).toISOString() },
          { id: 1, command: 'kickuser GrieferJoe', response: 'User GrieferJoe kicked.', success: 1, executed_at: new Date(Date.now() - 7_800_000).toISOString() },
        ],
      })
    }
    if (path === '/api/map/manifest') {
      return jsonResponse({ key: 'demo', folders: [], bounds: null, floors: { min: 0, max: 0 }, warnings: ['The demo has no map files. On a real server the map renders here.'] })
    }
    if (path === '/api/game-integration/players') {
      return jsonResponse({ success: true, data: { players: DEMO_PLAYERS.map(demoPlayerDetails) } })
    }
    if (path.startsWith('/api/game-integration/players/')) {
      const name = decodeURIComponent(path.split('/').pop() || '')
      const index = DEMO_PLAYERS.indexOf(name)
      return jsonResponse(index >= 0 ? { success: true, data: demoPlayerDetails(name, index) } : { success: false, error: 'Player is not online.' })
    }
    if (path === '/api/players/stats') {
      return jsonResponse({ stats: demoPlayerStats() })
    }
    if (path === '/api/players/steamid-bans') {
      return jsonResponse({ bans: [{ steamId: '76561198000000042', banned_at: new Date(Date.now() - 5 * 86_400_000).toISOString(), reason: 'Duping' }] })
    }
    if (path === '/api/players/whitelist') {
      return jsonResponse({
        success: true,
        available: true,
        accounts: ['Kate', 'Baldspot', 'nightowl_92', 'Marisol', 'Rook', 'Tamsin'].map((username, id) => ({
          id: id + 1,
          username,
          lastConnection: new Date(Date.now() - id * 86_400_000).toISOString(),
          role: id === 0 ? 'admin' : 'user',
          authType: 1,
          steamId: `7656119800000${String(1000 + id)}`,
          ownerId: null,
          displayName: username,
        })),
        allowedSteamIds: ['76561198000009001'],
      })
    }
    if (path === '/api/players/perks') {
      return jsonResponse({
        catalog: [
          { id: 'Aiming', label: 'Aiming', category: 'Firearm' },
          { id: 'Reloading', label: 'Reloading', category: 'Firearm' },
          { id: 'Woodwork', label: 'Carpentry', category: 'Crafting' },
          { id: 'Cooking', label: 'Cooking', category: 'Crafting' },
          { id: 'Sprinting', label: 'Sprinting', category: 'Agility' },
        ],
      })
    }
    if (path === '/api/players/access-levels') {
      return jsonResponse({ levels: ['admin', 'moderator', 'gm', 'observer', 'user', 'none'] })
    }
    if (path === '/api/players/activity') {
      return jsonResponse({ logs: demoActivity() })
    }
    if (path === '/api/debug/performance-history') {
      const limit = Math.min(1440, Math.max(1, Number(queryParam(input, 'limit')) || 60))
      return jsonResponse({ history: demoPerformanceHistory(limit) })
    }
    if (path === '/api/game-integration/world/stats') {
      return jsonResponse({ success: true, data: { serverName: 'DoomerZDemo', map: 'Muldraugh, KY', zombiesInCell: 214 } })
    }
    if (path === '/api/server/console-log/error-count') {
      return jsonResponse({ exists: true, count: 3, sinceStart: true })
    }
    if (path === '/api/scheduler/status') {
      return jsonResponse({
        maintenance: null,
        activeTasks: 2,
        autoRestartEnabled: true,
        nextRun: { label: 'Daily restart', at: new Date(Date.now() + (2 * 60 + 40) * 60_000).toISOString() },
        timezone: 'Europe/Istanbul',
      })
    }
    if (path === '/api/game-integration/status') {
      return jsonResponse({
        configured: true,
        isRunning: true,
        modConnected: true,
        path: '/opt/pz/argus',
        modStatus: {
          alive: true,
          version: '1.4.0',
          serverName: 'DoomerZDemo',
          playerCount: DEMO_PLAYERS.length,
          players: DEMO_PLAYERS,
          timestamp: Date.now(),
        },
        connection: {
          healthy: true,
          canSendCommands: true,
          issues: [],
          summary: 'Connected.',
        },
        localInstall: {
          installed: false,
          canAutoInstall: false,
          needsUpdate: false,
          restartRequired: false,
        },
      })
    }
    if (path === '/api/panel-info') {
      return jsonResponse({ localIp: '127.0.0.1', port: 3001, url: 'http://demo.local:3001' })
    }
    if (path === '/api/servers') {
      return jsonResponse({ servers: [demoServer()] })
    }
    if (/^\/api\/servers\/[^/]+$/.test(path)) {
      return jsonResponse({ server: demoServer() })
    }

    if (path === '/api/server/update/status') {
      return jsonResponse({
        updateAvailable: {
          updateAvailable: false,
          currentVersion: '0.6.0-demo',
        },
      })
    }
    if (path === '/api/server/update-check/status') {
      return jsonResponse({
        updateAvailable: {
          updateAvailable: false,
          installed: { buildId: '21143703', branch: 'unstable', lastUpdated: new Date().toISOString() },
          latest: { buildId: '21143703', branch: 'unstable', timeUpdated: null, description: null },
          lastCheck: new Date().toISOString(),
        },
        gameVersion: '42.15.2',
        lastCheck: new Date().toISOString(),
        intervalMinutes: 30,
        isChecking: false,
      })
    }

    if (path === '/api/server-files/paths') {
      return jsonResponse({
        serverId: 'demo-server',
        configPath: '/home/pz/Zomboid/Server',
        serverName: 'DoomerZDemo',
        files: {
          ini: '/home/pz/Zomboid/Server/DoomerZDemo.ini',
          sandbox: '/home/pz/Zomboid/Server/DoomerZDemo_SandboxVars.lua',
          spawnpoints: '/home/pz/Zomboid/Server/spawnpoints.lua',
          spawnregions: '/home/pz/Zomboid/Server/spawnregions.lua',
        },
        exists: {
          ini: true,
          sandbox: true,
          spawnpoints: true,
          spawnregions: true,
        },
      })
    }
    if (path === '/api/server-files/ini') {
      return jsonResponse({ settings: demoIniSettings(), path: '/home/pz/Zomboid/Server/DoomerZDemo.ini' })
    }
    if (path === '/api/server-files/sandbox') {
      return jsonResponse({
        sandbox: {
          VERSION: 4,
          settings: { DayLength: 3, StartYear: 1, StartMonth: 7, StartDay: 9, StartTime: 2, WaterShut: 2, ElecShut: 2, Zombies: 4 },
          ZombieLore: { Speed: 2, Strength: 2 },
          ZombieConfig: {},
          MultiplierConfig: {},
          Map: {},
          Basement: {},
        },
        path: '/home/pz/Zomboid/Server/DoomerZDemo_SandboxVars.lua',
      })
    }
    if (path === '/api/server-files/spawnpoints') {
      return jsonResponse({
        spawnpoints: {
          unemployed: [{ worldX: 40, worldY: 22, posX: 130, posY: 100, posZ: 0 }],
          fireofficer: [{ worldX: 40, worldY: 23, posX: 140, posY: 180, posZ: 0 }],
        },
        path: '/home/pz/Zomboid/Server/spawnpoints.lua',
      })
    }
    if (path === '/api/server-files/spawnregions') {
      return jsonResponse({
        spawnregions: [
          { name: 'Muldraugh, KY', file: 'media/maps/Muldraugh, KY/spawnpoints.lua' },
          { name: 'West Point, KY', file: 'media/maps/West Point, KY/spawnpoints.lua' },
        ],
        path: '/home/pz/Zomboid/Server/spawnregions.lua',
      })
    }
    if (path.startsWith('/api/server-files/raw/')) {
      const type = path.split('/').pop() || 'ini'
      return jsonResponse({
        content: `-- Demo mode raw file for ${type}\n-- No backend is connected on GitHub Pages.\n`,
        path: `/home/pz/Zomboid/Server/${type}.demo`,
        filename: `${type}.demo`,
      })
    }
    if (path === '/api/server-files/backups') {
      return jsonResponse({ backups: [], path: '/home/pz/Zomboid/Server/backups' })
    }
    if (path === '/api/backup/status') {
      return jsonResponse({
        enabled: false, schedule: '0 */6 * * *', maxBackups: 10, waitMinutes: 60,
        forceAfterMinutes: null, forceWarningMinutes: 15,
        backupInProgress: false, restoreInProgress: false, lastBackup: null,
        backupCount: 0, savesPath: '/home/pz/Zomboid/Saves/Multiplayer/DoomerZDemo',
        backupsPath: '/home/pz/Zomboid/backups', savesExists: true,
        lastScheduledBackupAttempt: null,
      })
    }
    if (path === '/api/backup/list') return jsonResponse({ backups: [] })
    if (path === '/api/backup/history') return jsonResponse({ records: [] })
    if (path === '/api/mods/status') {
      return jsonResponse(demoModsStatus())
    }
    if (path === '/api/mods/tracked') {
      return jsonResponse({ mods: demoTrackedMods })
    }
    if (path === '/api/mods/current-config') {
      return jsonResponse(demoCurrentConfig())
    }
    if (path === '/api/mods/server-mods') {
      return jsonResponse({
        workshopIds: demoCurrentConfig().workshopIds,
        modIds: demoCurrentConfig().modIds,
        maps: demoCurrentConfig().maps,
      })
    }
    if (path === '/api/mods/workshop-status') {
      return jsonResponse({
        configured: true,
        path: '/opt/pz/steamapps/workshop/appworkshop_108600.acf',
        workshopItems: demoTrackedMods.length + 3,
        lastModified: demoTimestamp,
      })
    }
    if (path === '/api/mods/ignored') {
      return jsonResponse([
        { workshop_id: '3000000001', name: 'Authentic Z Mirror', ignored_at: '2026-06-21T11:20:00.000Z' },
      ])
    }
    if (path === '/api/mods/ignored-pairs') {
      return jsonResponse([
        {
          mod_a: 'TchernoLib',
          mod_b: 'Brita',
          reason: 'Known library dependency, kept visible as low priority in demo scan.',
          server_id: 'demo-server',
          ignored_at: '2026-06-22T19:15:00.000Z',
        },
      ])
    }
    if (path === '/api/mods/conflicts' || path === '/api/mods/conflicts/cached') {
      return jsonResponse(demoConflictScan())
    }
    if (path === '/api/mods/disk-only') {
      return jsonResponse({
        mods: [
          { workshop_id: '2719327441', name: 'Mod Manager: Server' },
          { workshop_id: '3000000002', name: 'Legacy Vehicle Pack' },
        ],
      })
    }
    if (path === '/api/mods/search-workshop-mods' && method === 'POST') {
      const body = await readJsonBody(init)
      return jsonResponse(demoWorkshopSearch(typeof body.query === 'string' ? body.query : ''))
    }
    if (path === '/api/mods/discover-mod-ids' && method === 'POST') {
      const body = await readJsonBody(init)
      const workshopId = typeof body.workshopId === 'string' && body.workshopId ? body.workshopId : '2849247394'
      return jsonResponse({
        success: true,
        workshopId,
        name: workshopId === '2849247394' ? 'Authentic Z' : `Workshop Mod ${workshopId}`,
        description: 'Demo mode discovery result from static metadata.',
        modIds: workshopId === '2849247394' ? ['AuthenticZLite', 'AuthenticZBackpacks'] : ['DemoModId'],
        hasMultipleModIds: workshopId === '2849247394',
        sources: workshopId === '2849247394'
          ? [
              { modId: 'AuthenticZLite', source: 'mod.info' },
              { modId: 'AuthenticZBackpacks', source: 'mod.info' },
            ]
          : [{ modId: 'DemoModId', source: 'mod.info' }],
        isMap: false,
        mapFolders: [],
        isDownloaded: true,
        tags: ['Demo', 'Workshop'],
      })
    }
    if (path === '/api/mods/import-collection' && method === 'POST') {
      return jsonResponse({
        success: true,
        collectionTitle: 'DoomerZ Demo Collection',
        imported: demoTrackedMods.length,
        skipped: 1,
        mods: demoTrackedMods,
        message: 'Demo mode: collection import preview acknowledged.',
      })
    }
    if (path === '/api/mods/get-mod-info' && method === 'POST') {
      const body = await readJsonBody(init)
      const workshopId = typeof body.workshopId === 'string' ? body.workshopId : '2849247394'
      const known = demoTrackedMods.find(mod => mod.workshop_id === workshopId)
      return jsonResponse({
        success: true,
        workshopId,
        name: known?.name || `Workshop Mod ${workshopId}`,
        title: known?.name || `Workshop Mod ${workshopId}`,
        description: 'Demo mode Workshop metadata.',
      })
    }
    if (path === '/api/mods/collection/diff') {
      return jsonResponse(demoCollectionDiff())
    }
    if (path === '/api/mods/resolve-missing-deps' && method === 'POST') {
      return jsonResponse({
        success: true,
        resolvedCount: 1,
        deps: [
          { missingDep: 'Arsenal(26)GunFighter', resolvedWorkshopId: '2297098490', resolvedModName: 'Arsenal GunFighter' },
        ],
      })
    }
    if (path === '/api/mods/add-missing-dep' && method === 'POST') {
      return jsonResponse({
        success: true,
        workshopId: '2297098490',
        modId: 'Arsenal(26)GunFighter',
        wsAdded: true,
        modIdAdded: true,
        mapFolders: [],
        message: 'Demo mode: dependency would be added to the server INI.',
      })
    }
    if (path === '/api/mods/add-all-resolved-deps' && method === 'POST') {
      return jsonResponse({
        success: true,
        total: 1,
        wsAdded: 1,
        modIdsAdded: 1,
        mapFolders: [],
        message: 'Demo mode: resolved dependencies would be added.',
      })
    }
    if (path === '/api/mods/enable-disk-mod' && method === 'POST') {
      const body = await readJsonBody(init)
      return jsonResponse({ success: true, workshopId: body.workshopId || 'demo', modIdsAdded: 1 })
    }
    if (path === '/api/mods/delete-disk-mod' && method === 'POST') {
      const body = await readJsonBody(init)
      return jsonResponse({ success: true, workshopId: body.workshopId || 'demo', deletedFromDisk: true, modIdsStripped: 1 })
    }
    if (path === '/api/mods/batch-delete-disk-mods' && method === 'POST') {
      const body = await readJsonBody(init)
      const ids = Array.isArray(body.workshopIds) ? body.workshopIds : []
      return jsonResponse({
        success: true,
        total: ids.length,
        deletedFromDisk: ids.length,
        modIdsStripped: ids.length,
        results: ids.map(workshopId => ({ workshopId, deletedFromDisk: true })),
      })
    }
    if (path === '/api/mods/add-mod-advanced' && method === 'POST') {
      const body = await readJsonBody(init)
      const selectedModIds = Array.isArray(body.selectedModIds) ? body.selectedModIds : ['DemoModId']
      return jsonResponse({
        success: true,
        workshopId: body.workshopId || 'demo',
        addedModIds: selectedModIds,
        totalModIdsInConfig: demoCurrentConfig().modIds.length + selectedModIds.length,
        workshopAlreadyExisted: false,
        mapFoldersAdded: [],
        message: 'Demo mode: selected mod IDs would be written to the INI.',
      })
    }
    if (path.startsWith('/api/mods/') && method !== 'GET') {
      return jsonResponse({ success: true, message: 'Demo mode: mod action acknowledged (no backend connected).' })
    }

    if (method !== 'GET') {
      return jsonResponse({ success: true, message: 'Demo mode: action acknowledged (no backend connected).' })
    }

    return jsonResponse({ success: true, demo: true })
  }

  demoFetchInstalled = true
}
