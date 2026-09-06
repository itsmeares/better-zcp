import express from 'express';
import dgram from 'dgram';
import { createLogger } from '../utils/logger.js';
const log = createLogger('API:Finder');
import { getSteamApiKey } from '../services/steamApiKey.js';
import { sanitizeError } from '../utils/sanitize.js';
import { requirePermission } from '../services/permissions.js';

const router = express.Router();

// A setup/verification diagnostic (queries the Steam master server list,
// pings arbitrary public IPs the caller supplies) rather than a player- or
// server-operations feature — admin+technician, not moderator, matching
// this program's default for "operate/configure the server" tooling.
// Applied once at the router level (4 endpoints).
router.use(requirePermission('server.install'));

// Block private/reserved IP ranges to prevent SSRF
export function isPrivateIp(ip) {
  if (typeof ip !== 'string') return true;
  // Trim whitespace
  ip = ip.trim();
  // Block non-IPv4 patterns (no IPv6 support in this feature)
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  const parts = ip.split('.').map(Number);
  if (parts.some(p => p < 0 || p > 255 || isNaN(p))) return true;
  const [a, b] = parts;
  // 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16-31.0.0/12, 192.168.0.0/16, 224-255 (multicast/reserved)
  if (a === 0 || a === 10 || a === 127) return true;
  // 100.64.0.0/10 (RFC 6598, Carrier-Grade NAT / shared address space) --
  // increasingly used as an internal routing range by cloud providers and
  // some Docker/Kubernetes CNI setups, so it needs the same block as the
  // other private ranges above.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast + reserved
  return false;
}

// Validate IP format for query/ping endpoints
function validateQueryIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  if (isPrivateIp(ip)) return false;
  return true;
}

export function parseQueryPort(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 && value <= 65535
      ? value
      : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

// Project Zomboid App ID on Steam
const PZ_APP_ID = 108600;

// Steam Master Server addresses
const MASTER_SERVERS = [
  { host: 'hl2master.steampowered.com', port: 27011 },
];

// Timeout for queries (ms)
const QUERY_TIMEOUT = 10000;
const SERVER_QUERY_TIMEOUT = 3000;

// Bound the fallback fan-out. The cap is returned as
// masterDiscovery.truncated so a short result stays distinguishable from an
// intentionally truncated one.
const MAX_MASTER_SERVERS_TO_QUERY = 200;

/**
 * Query a single game server for detailed info using A2S_INFO protocol
 */
export function buildA2SInfoQuery(challenge = null) {
  const base = Buffer.from([
    0xFF, 0xFF, 0xFF, 0xFF, 0x54,
    ...Buffer.from("Source Engine Query\0"),
  ]);
  return challenge ? Buffer.concat([base, challenge]) : base;
}

// Shared between GET /query and GET /ping so both name the same cause the
// same way. Kept as its own map rather than inlined in either route so a
// third caller of queryServerInfo's reason gets the same wording for free.
export const QUERY_FAILURE_MESSAGES = {
  timeout: 'Server did not respond (timed out)',
  'socket-error': 'Could not reach the server (network error)',
  'unparseable-response': 'Server responded with data the panel could not parse',
};

// onFailureReason, if given, is invoked with 'timeout' | 'socket-error' |
// 'unparseable-response' right before a null resolve -- optional and
// side-channel so the resolved value's contract (info object or null) is
// completely unchanged for the batch caller in GET / and the existing
// challenge-handling test, both of which only care about truthy-or-null.
// GET /query and GET /ping pass it to turn one generic "didn't respond"
// outcome back into the three genuinely different causes it collapsed.
export async function queryServerInfo(ip, port, onFailureReason) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let timeout = setTimeout(() => {
      socket.close();
      onFailureReason?.('timeout');
      resolve(null);
    }, SERVER_QUERY_TIMEOUT);
    let challengeRetried = false;

    socket.on('error', () => {
      clearTimeout(timeout);
      socket.close();
      onFailureReason?.('socket-error');
      resolve(null);
    });

    socket.on('message', (msg) => {
      clearTimeout(timeout);
      timeout = null;
      if (
        msg.length >= 9 &&
        msg.readUInt8(4) === 0x41 &&
        !challengeRetried
      ) {
        challengeRetried = true;
        const challenge = msg.subarray(5, 9);
        timeout = setTimeout(() => {
          socket.close();
          onFailureReason?.('timeout');
          resolve(null);
        }, SERVER_QUERY_TIMEOUT);
        // No destination args -- this socket is connect()-ed, see below.
        // send() on a connected UDP socket can throw SYNCHRONOUSLY (e.g.
        // ERR_SOCKET_BAD_PORT) -- this call is inside a 'message' listener,
        // so a throw here would escape both this Promise's executor and
        // the socket's own 'error' handler and become a process-crashing
        // uncaught exception instead of a resolved query failure. See the
        // matching try/catch on the initial send() below and
        // serverFinderSocketSendSyncThrow.test.js for why this matters.
        try {
          socket.send(buildA2SInfoQuery(challenge));
        } catch (err) {
          clearTimeout(timeout);
          socket.close();
          onFailureReason?.('socket-error');
          resolve(null);
        }
        return;
      }
      try {
        const info = parseA2SInfoResponse(msg);
        info.ip = ip;
        info.port = port;
        info.queryPort = port;
        socket.close();
        resolve(info);
      } catch (e) {
        socket.close();
        onFailureReason?.('unparseable-response');
        resolve(null);
      }
    });

    // A2S_INFO query packet. A server may answer with a challenge; the
    // message handler retries once with the challenge appended as required by
    // the protocol.
    //
    // A connected socket accepts replies only from the requested address,
    // preventing another host from fabricating the response after the SSRF
    // checks have passed.
    socket.connect(port, ip, () => {
      // A synchronous send() error inside this callback would otherwise escape
      // the Promise and terminate the server process.
      try {
        socket.send(buildA2SInfoQuery());
      } catch (err) {
        clearTimeout(timeout);
        socket.close();
        onFailureReason?.('socket-error');
        resolve(null);
      }
    });
  });
}

/**
 * Parse A2S_INFO response
 */
function parseA2SInfoResponse(buffer) {
  let offset = 4; // Skip header (0xFFFFFFFF)

  const header = buffer.readUInt8(offset++);

  // Check for challenge response (0x41 = 'A')
  if (header === 0x41) {
    // Server sent a challenge, we'd need to resend with the challenge
    // For simplicity, we'll skip servers that require challenges
    throw new Error('Challenge required');
  }

  // 'I' (0x49) = Source server info response
  // 'm' (0x6D) = Obsolete GoldSource response
  if (header !== 0x49 && header !== 0x6D) {
    throw new Error('Invalid response header');
  }

  const info = {};

  // Protocol version
  info.protocol = buffer.readUInt8(offset++);

  // Read null-terminated strings
  const readString = () => {
    const start = offset;
    while (buffer[offset] !== 0 && offset < buffer.length) offset++;
    const str = buffer.toString('utf8', start, offset);
    offset++; // Skip null terminator
    return str;
  };

  info.name = readString();
  info.map = readString();
  info.folder = readString();
  info.game = readString();

  // Steam App ID (short)
  info.appId = buffer.readUInt16LE(offset);
  offset += 2;

  // Players
  info.players = buffer.readUInt8(offset++);
  info.maxPlayers = buffer.readUInt8(offset++);
  info.bots = buffer.readUInt8(offset++);

  // Server type: 'd' = dedicated, 'l' = listen, 'p' = SourceTV
  info.serverType = String.fromCharCode(buffer.readUInt8(offset++));

  // Environment: 'l' = Linux, 'w' = Windows, 'm'/'o' = Mac
  info.environment = String.fromCharCode(buffer.readUInt8(offset++));

  // Visibility: 0 = public, 1 = private
  info.visibility = buffer.readUInt8(offset++);
  info.isPrivate = info.visibility === 1;

  // VAC: 0 = unsecured, 1 = secured
  info.vac = buffer.readUInt8(offset++);

  // Version
  info.version = readString();

  // Extra data flag (EDF)
  if (offset < buffer.length) {
    const edf = buffer.readUInt8(offset++);

    // Port
    if (edf & 0x80) {
      info.gamePort = buffer.readUInt16LE(offset);
      offset += 2;
    }

    // Steam ID
    if (edf & 0x10) {
      // 64-bit Steam ID
      offset += 8;
    }

    // SourceTV
    if (edf & 0x40) {
      info.sourceTvPort = buffer.readUInt16LE(offset);
      offset += 2;
      info.sourceTvName = readString();
    }

    // Keywords/Tags
    if (edf & 0x20) {
      info.keywords = readString();
    }

    // Game ID
    if (edf & 0x01) {
      // 64-bit Game ID
      offset += 8;
    }
  }

  return info;
}

/**
 * Query Steam Master Server for game servers
 */
export async function queryMasterServer(masterHost, masterPort, region = 0xFF, filters = '') {
  return new Promise((resolve, reject) => {
    // A connected UDP socket accepts replies only from the resolved master,
    // preventing a spoofed response from steering the fallback to an internal
    // address.
    const socket = dgram.createSocket('udp4');
    const servers = [];
    let lastIp = '0.0.0.0';
    let lastPort = 0;

    const timeout = setTimeout(() => {
      socket.close();
      resolve(servers);
    }, QUERY_TIMEOUT);

    socket.on('error', (err) => {
      clearTimeout(timeout);
      socket.close();
      reject(err);
    });

    socket.on('message', (msg) => {
      // Parse response
      // Header: 0xFF 0xFF 0xFF 0xFF 0x66 0x0A
      if (msg.length < 6) return;

      let offset = 6;
      while (offset + 6 <= msg.length) {
        const ip = `${msg[offset]}.${msg[offset + 1]}.${msg[offset + 2]}.${msg[offset + 3]}`;
        const port = msg.readUInt16BE(offset + 4);
        offset += 6;

        // 0.0.0.0:0 marks end of list
        if (ip === '0.0.0.0' && port === 0) {
          clearTimeout(timeout);
          socket.close();
          resolve(servers);
          return;
        }

        servers.push({ ip, port });
        lastIp = ip;
        lastPort = port;
      }

      // Request more servers if list continues
      if (servers.length > 0) {
        sendQuery(lastIp, lastPort);
      }
    });

    const sendQuery = (seedIp = '0.0.0.0', seedPort = 0) => {
      // Master Server Query packet
      // Type: 0x31
      // Region: 0xFF (all regions)
      // IP:Port seed
      // Filter string
      const seedAddr = `${seedIp}:${seedPort}`;
      const filterStr = filters + '\0';

      const packet = Buffer.alloc(2 + seedAddr.length + 1 + filterStr.length);
      let offset = 0;

      packet.writeUInt8(0x31, offset++); // Query type
      packet.writeUInt8(region, offset++); // Region

      // Seed address
      Buffer.from(seedAddr).copy(packet, offset);
      offset += seedAddr.length;
      packet.writeUInt8(0, offset++); // Null terminator

      // Filter
      Buffer.from(filterStr).copy(packet, offset);

      // No destination args -- this socket is connect()-ed, see above.
      //
      // send() on a connected UDP socket can throw SYNCHRONOUSLY (observed
      // in production: RangeError [ERR_SOCKET_BAD_PORT], the connected
      // socket's own remote port having gone bad after connect()'s
      // callback already fired -- not a caller passing a bad masterPort,
      // which fails at connect() itself, before this ever runs). sendQuery
      // is called from two places, both inside async callbacks (the
      // connect() callback below, and the 'message' handler above for
      // pagination) -- NEITHER is inside this function's own Promise
      // executor, so a throw here would reach neither `reject` above nor
      // the socket's own 'error' listener. Node's default handling of an
      // uncaught exception is to kill the whole process, not just this
      // request -- confirmed the hard way, twice, via
      // a manual browser smoke test.
      // Catching it here, once, covers both call sites.
      try {
        socket.send(packet);
      } catch (err) {
        clearTimeout(timeout);
        socket.close();
        reject(err);
      }
    };

    // sendQuery() only runs once the connect() actually resolves (the
    // 'connect' event / this callback) -- a DNS failure or refused
    // connect fires the 'error' handler above instead, which already
    // rejects and cleans up.
    socket.connect(masterPort, masterHost, () => {
      sendQuery();
    });
  });
}

// Simple in-memory cache for server list
let serverCache = {
  data: null,
  timestamp: 0,
  ttl: 60000, // 1 minute cache
};

/**
 * Alternative: Use Steam Web API to get server list
 * Requires steamApiKey from settings database
 * Makes parallel requests with different filters to get more servers
 */
async function getServersFromSteamAPI(apiKey, useCache = true) {
  if (!apiKey) {
    throw new Error('Steam API Key not configured in Settings');
  }

  // Check cache
  if (useCache && serverCache.data && (Date.now() - serverCache.timestamp) < serverCache.ttl) {
    log.debug(`Returning ${serverCache.data.length} servers from cache`);
    return serverCache.data;
  }

  const allServers = new Map(); // Use Map to deduplicate by addr

  // Different filters to maximize server coverage (run in parallel)
  const baseFilters = [
    `\\appid\\${PZ_APP_ID}`, // All servers (up to limit)
    `\\appid\\${PZ_APP_ID}\\white\\1`, // Whitelisted servers
    `\\appid\\${PZ_APP_ID}\\full\\1`, // Full servers (might be missed otherwise)
  ];

  const fetchWithFilter = async (filter) => {
    try {
      const url = `https://api.steampowered.com/IGameServersService/GetServerList/v1/?key=${apiKey}&filter=${encodeURIComponent(filter)}&limit=10000`;
      const response = await fetch(url);
      if (!response.ok) {
        log.warn(`Steam API request failed for filter ${filter}: ${response.status}`);
        return [];
      }
      const data = await response.json();
      return data.response?.servers || [];
    } catch (error) {
      log.warn(`Steam API request failed for filter ${filter}:`, error.message);
      return [];
    }
  };

  // Fetch all filters in parallel
  const results = await Promise.all(baseFilters.map(fetchWithFilter));

  // Merge and deduplicate
  for (const servers of results) {
    for (const server of servers) {
      if (server.addr) {
        allServers.set(server.addr, server);
      }
    }
  }

  log.info(`Steam API returned ${allServers.size} unique servers`);

  // Update cache
  const serverArray = Array.from(allServers.values());
  serverCache = {
    data: serverArray,
    timestamp: Date.now(),
    ttl: 60000,
  };

  return serverArray;
}

export function mapSteamServer(server) {
  const gametype = server.gametype || "";
  const tags = gametype
    .split(";")
    .filter((tag) => tag && !tag.startsWith("VERSION:"));
  const versionMatch = gametype.match(/VERSION:([0-9.]+)/);
  const gameVersion = versionMatch ? versionMatch[1] : "";

  // port is derived (addr first, then the raw gameport field as a
  // fallback) rather than read directly, so an unparseable value must stay
  // null rather than default to a guessed port (16261 is PZ's default, but
  // guessing it here would be indistinguishable downstream from a port
  // that was actually read -- a fabricated plausible value is worse than a
  // null, since null is at least detectable). Matches this file's own
  // `ping: null` convention for "we don't have this value" elsewhere.
  const addrParts = server.addr?.split(":") || [];
  const portFromAddr = parseQueryPort(addrParts[1]);
  const port =
    portFromAddr !== null ? portFromAddr : parseQueryPort(server.gameport);

  return {
    name: server.name || "Unknown",
    ip: addrParts[0] || "",
    port,
    gamePort: server.gameport,
    players: server.players || 0,
    maxPlayers: server.max_players || 0,
    map: server.map || "Muldraugh, KY",
    version: gameVersion,
    vac: server.secure || false,
    isPrivate: server.password || false,
    os: server.os === "l" ? "Linux" : server.os === "w" ? "Windows" : "Unknown",
    dedicated: server.dedicated ?? true,
    bots: server.bots || 0,
    steamId: server.steamid,
    gamedir: server.gamedir,
    keywords: gametype,
    tags,
    ping: null,
  };
}

// The master-server fallback path used to report an identical
// `servers: []` for three genuinely different outcomes: the master
// genuinely listed zero PZ servers, the master listed servers but none of
// them answered the follow-up A2S query, or the master itself could never
// be reached. Only meaningful for the master_server path with zero results
// -- undefined otherwise, dropped from the JSON response by JSON.stringify.
export function deriveEmptyReason({ source, serversFound, mastersReachable, mastersListedCount }) {
  if (source !== 'master_server' || serversFound > 0) return undefined;
  if (!mastersReachable) return 'master-unreachable';
  return mastersListedCount > 0 ? 'no-servers-responded' : 'no-servers-listed';
}

// Surfaces the master-server fallback's filtering and query cap, so a short
// result is not ambiguous:
//   - privateFiltered: entries refused because isPrivateIp() flagged them
//     (same SSRF guard used by GET /query and GET /ping).
//   - truncated: the queryable count exceeded MAX_MASTER_SERVERS_TO_QUERY,
//     so `queried` is a prefix, not the full list.
// Only meaningful for the master_server path -- undefined otherwise,
// dropped from the JSON response by JSON.stringify, matching
// deriveEmptyReason's own convention above.
export function deriveMasterDiscoveryStats({
  source,
  mastersListedCount,
  mastersPrivateFilteredCount,
  mastersQueriedCount,
  mastersTruncated,
}) {
  if (source !== 'master_server') return undefined;
  return {
    listed: mastersListedCount,
    privateFiltered: mastersPrivateFilteredCount,
    queried: mastersQueriedCount,
    truncated: mastersTruncated,
  };
}

// Applies both decisions GET /'s master-server fallback makes about a raw
// master-listed candidate list before probing any of it: the SSRF filter
// (isPrivateIp) and the query cap (MAX_MASTER_SERVERS_TO_QUERY). Extracted
// as its own pure function so the cap can be tested without live UDP calls.
export function selectMasterServersToQuery(masterServers) {
  const queryable = masterServers.filter((s) => !isPrivateIp(s.ip));
  return {
    toQuery: queryable.slice(0, MAX_MASTER_SERVERS_TO_QUERY),
    privateFilteredCount: masterServers.length - queryable.length,
    truncated: queryable.length > MAX_MASTER_SERVERS_TO_QUERY,
  };
}

// Surface the Steam API error only when the fallback also returns no servers.
// A successful fallback should not report an earlier, recovered error.
export function deriveSteamApiFailureReason({ steamApiError, serversFound }) {
  if (!steamApiError || serversFound > 0) return undefined;
  return sanitizeError(steamApiError);
}

/**
 * Get server list - tries Steam API first, falls back to master server query
 */
router.get('/', async (req, res) => {
  try {
    log.info(`GET / (server finder): refresh=${req.query.refresh || 'false'}`);
    let servers = [];
    let source = 'steam_api';
    const steamApiKey = await getSteamApiKey();
    let apiKeyConfigured = !!steamApiKey;
    const forceRefresh = req.query.refresh === 'true';
    let cached = false;
    let steamApiError = null;

    // Try Steam Web API first (more reliable)
    if (steamApiKey) {
      try {
        // Check if using cache
        if (!forceRefresh && serverCache.data && (Date.now() - serverCache.timestamp) < serverCache.ttl) {
          cached = true;
        }
        const apiServers = await getServersFromSteamAPI(steamApiKey, !forceRefresh);
        servers = apiServers.map(mapSteamServer);

        log.info(`Found ${servers.length} PZ servers via Steam API`);
      } catch (apiError) {
        log.warn('Steam API failed, trying master server query:', apiError.message);
        steamApiError = apiError.message;
        source = 'master_server';
      }
    }

    // Fallback to master server query (less reliable but works without API key)
    // emptyReason distinguishes three causes that used to collapse into the
    // same "servers: []": the master genuinely listed nothing, the master
    // listed servers but none of them answered the follow-up A2S query, or
    // the master itself could never be reached. Only computed (and only
    // included in the response) when this fallback path actually ran and
    // came up empty -- the common non-empty case is untouched.
    let mastersReachable = false;
    let mastersListedCount = 0;
    let mastersPrivateFilteredCount = 0;
    let mastersQueriedCount = 0;
    let mastersTruncated = false;
    if (servers.length === 0) {
      source = 'master_server';
      try {
        // Query master server for Project Zomboid servers
        const filter = `\\appid\\${PZ_APP_ID}`;

        for (const master of MASTER_SERVERS) {
          try {
            const masterServers = await queryMasterServer(master.host, master.port, 0xFF, filter);
            mastersReachable = true;
            mastersListedCount += masterServers.length;

            // Apply the same SSRF guard as the direct query routes and expose
            // both filtering and truncation in the response.
            const { toQuery: serversToQuery, privateFilteredCount, truncated } =
              selectMasterServersToQuery(masterServers);
            mastersPrivateFilteredCount += privateFilteredCount;
            if (truncated) mastersTruncated = true;
            mastersQueriedCount += serversToQuery.length;

            // Query each server for details (limit concurrent queries)
            const batchSize = 50;
            for (let i = 0; i < serversToQuery.length; i += batchSize) {
              const batch = serversToQuery.slice(i, i + batchSize);
              const results = await Promise.all(
                batch.map(s => queryServerInfo(s.ip, s.port))
              );

              servers.push(...results.filter(Boolean));
            }

            if (servers.length > 0) break;
          } catch (e) {
            log.warn(`Master server ${master.host} query failed:`, e.message);
          }
        }

        log.info(`Found ${servers.length} PZ servers via master server`);
      } catch (masterError) {
        log.error('Master server query failed:', masterError.message);
      }
    }
    const emptyReason = deriveEmptyReason({
      source,
      serversFound: servers.length,
      mastersReachable,
      mastersListedCount,
    });
    const masterDiscovery = deriveMasterDiscoveryStats({
      source,
      mastersListedCount,
      mastersPrivateFilteredCount,
      mastersQueriedCount,
      mastersTruncated,
    });
    const steamApiFailure = deriveSteamApiFailureReason({
      steamApiError,
      serversFound: servers.length,
    });

    // Sort by player count (descending)
    servers.sort((a, b) => (b.players || 0) - (a.players || 0));

    // Calculate statistics
    const totalPlayers = servers.reduce((sum, s) => sum + (s.players || 0), 0);
    const activeServers = servers.filter(s => s.players > 0).length;
    const totalCapacity = servers.reduce((sum, s) => sum + (s.maxPlayers || 0), 0);

    res.json({
      success: true,
      source,
      cached,
      count: servers.length,
      totalPlayers,
      activeServers,
      totalCapacity,
      servers, // Return ALL servers, frontend handles pagination
      apiKeyConfigured,
      emptyReason, // undefined (dropped by JSON.stringify) outside the empty master_server case
      masterDiscovery, // undefined outside the master_server path -- see deriveMasterDiscoveryStats
      steamApiFailure, // undefined unless the Steam API threw AND the fallback also came up empty
    });
  } catch (error) {
    log.error('Failed to get server list:', error);
    res.status(500).json({
      success: false,
      error: sanitizeError(error.message),
    });
  }
});

/**
 * Query a specific server for its current info
 */
router.get('/query', async (req, res) => {
  const { ip, port } = req.query;
  log.info(`GET /query: ip=${ip}, port=${port}`);

  if (!ip || !port) {
    return res.status(400).json({
      success: false,
      error: 'IP and port are required',
    });
  }

  // Block private/reserved IPs to prevent SSRF
  if (!validateQueryIp(ip)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid or disallowed IP address',
    });
  }

  // Validate port is a valid number
  const portNum = parseQueryPort(port);
  if (portNum === null) {
    return res.status(400).json({
      success: false,
      error: 'Invalid port number',
    });
  }

  try {
    let reason = 'timeout';
    const info = await queryServerInfo(ip, portNum, (r) => { reason = r; });

    if (!info) {
      return res.status(504).json({
        success: false,
        error: QUERY_FAILURE_MESSAGES[reason],
        reason,
      });
    }

    res.json({
      success: true,
      server: info,
    });
  } catch (error) {
    log.error('Failed to query server:', error);
    res.status(500).json({
      success: false,
      error: sanitizeError(error.message),
    });
  }
});

/**
 * Ping a server to get latency
 */
router.get('/ping', async (req, res) => {
  const { ip, port } = req.query;

  if (!ip || !port) {
    return res.status(400).json({
      success: false,
      error: 'IP and port are required',
    });
  }

  // Block private/reserved IPs to prevent SSRF
  if (!validateQueryIp(ip)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid or disallowed IP address',
    });
  }

  // Validate port is a valid number
  const portNum = parseQueryPort(port);
  if (portNum === null) {
    return res.status(400).json({
      success: false,
      error: 'Invalid port number',
    });
  }

  const startTime = Date.now();

  try {
    let reason = 'timeout';
    const info = await queryServerInfo(ip, portNum, (r) => { reason = r; });
    const ping = Date.now() - startTime;

    if (!info) {
      return res.json({
        success: true,
        ping: null,
        online: false,
        reason,
      });
    }

    res.json({
      success: true,
      ping,
      online: true,
    });
  } catch (error) {
    res.json({
      success: true,
      ping: null,
      online: false,
    });
  }
});

/**
 * Debug endpoint - get raw Steam API data for a sample of servers
 */
router.get('/debug', async (req, res) => {
  try {
    const steamApiKey = await getSteamApiKey();
    if (!steamApiKey) {
      return res.status(400).json({ error: 'Steam API key not configured' });
    }

    // Get just a few servers with raw data
    const url = `https://api.steampowered.com/IGameServersService/GetServerList/v1/?key=${steamApiKey}&filter=\\appid\\${PZ_APP_ID}\\noplayers\\0&limit=10`;

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(500).json({ error: `Steam API error: ${response.status}` });
    }

    const data = await response.json();
    const servers = data.response?.servers || [];

    res.json({
      success: true,
      count: servers.length,
      rawServers: servers,
      fieldNames: servers.length > 0 ? Object.keys(servers[0]) : [],
    });
  } catch (error) {
    log.error('Debug endpoint error:', error);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
