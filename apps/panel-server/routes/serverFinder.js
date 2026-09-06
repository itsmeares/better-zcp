import express from 'express';
import dgram from 'dgram';
import { createLogger } from '../utils/logger.js';
const log = createLogger('API:Finder');
import { getSteamApiKey } from '../services/steamApiKey.js';
import { sanitizeError } from '../utils/sanitize.js';
import { requirePermission } from '../services/permissions.js';

const router = express.Router();

router.use(requirePermission('server.install'));

export function isPrivateIp(ip) {
  if (typeof ip !== 'string') return true;
  ip = ip.trim();
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  const parts = ip.split('.').map(Number);
  if (parts.some(p => p < 0 || p > 255 || isNaN(p))) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

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

const PZ_APP_ID = 108600;

const MASTER_SERVERS = [
  { host: 'hl2master.steampowered.com', port: 27011 },
];

const QUERY_TIMEOUT = 10000;
const SERVER_QUERY_TIMEOUT = 3000;

const MAX_MASTER_SERVERS_TO_QUERY = 200;

export function buildA2SInfoQuery(challenge = null) {
  const base = Buffer.from([
    0xFF, 0xFF, 0xFF, 0xFF, 0x54,
    ...Buffer.from("Source Engine Query\0"),
  ]);
  return challenge ? Buffer.concat([base, challenge]) : base;
}

export const QUERY_FAILURE_MESSAGES = {
  timeout: 'Server did not respond (timed out)',
  'socket-error': 'Could not reach the server (network error)',
  'unparseable-response': 'Server responded with data the panel could not parse',
};

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

    socket.connect(port, ip, () => {
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

function parseA2SInfoResponse(buffer) {
  let offset = 4;

  const header = buffer.readUInt8(offset++);

  if (header === 0x41) {
    throw new Error('Challenge required');
  }

  if (header !== 0x49 && header !== 0x6D) {
    throw new Error('Invalid response header');
  }

  const info = {};

  info.protocol = buffer.readUInt8(offset++);

  const readString = () => {
    const start = offset;
    while (buffer[offset] !== 0 && offset < buffer.length) offset++;
    const str = buffer.toString('utf8', start, offset);
    offset++;
    return str;
  };

  info.name = readString();
  info.map = readString();
  info.folder = readString();
  info.game = readString();

  info.appId = buffer.readUInt16LE(offset);
  offset += 2;

  info.players = buffer.readUInt8(offset++);
  info.maxPlayers = buffer.readUInt8(offset++);
  info.bots = buffer.readUInt8(offset++);

  info.serverType = String.fromCharCode(buffer.readUInt8(offset++));

  info.environment = String.fromCharCode(buffer.readUInt8(offset++));

  info.visibility = buffer.readUInt8(offset++);
  info.isPrivate = info.visibility === 1;

  info.vac = buffer.readUInt8(offset++);

  info.version = readString();

  if (offset < buffer.length) {
    const edf = buffer.readUInt8(offset++);

    if (edf & 0x80) {
      info.gamePort = buffer.readUInt16LE(offset);
      offset += 2;
    }

    if (edf & 0x10) {
      offset += 8;
    }

    if (edf & 0x40) {
      info.sourceTvPort = buffer.readUInt16LE(offset);
      offset += 2;
      info.sourceTvName = readString();
    }

    if (edf & 0x20) {
      info.keywords = readString();
    }

    if (edf & 0x01) {
      offset += 8;
    }
  }

  return info;
}

export async function queryMasterServer(masterHost, masterPort, region = 0xFF, filters = '') {
  return new Promise((resolve, reject) => {
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
      if (msg.length < 6) return;

      let offset = 6;
      while (offset + 6 <= msg.length) {
        const ip = `${msg[offset]}.${msg[offset + 1]}.${msg[offset + 2]}.${msg[offset + 3]}`;
        const port = msg.readUInt16BE(offset + 4);
        offset += 6;

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

      if (servers.length > 0) {
        sendQuery(lastIp, lastPort);
      }
    });

    const sendQuery = (seedIp = '0.0.0.0', seedPort = 0) => {
      const seedAddr = `${seedIp}:${seedPort}`;
      const filterStr = filters + '\0';

      const packet = Buffer.alloc(2 + seedAddr.length + 1 + filterStr.length);
      let offset = 0;

      packet.writeUInt8(0x31, offset++);
      packet.writeUInt8(region, offset++);

      Buffer.from(seedAddr).copy(packet, offset);
      offset += seedAddr.length;
      packet.writeUInt8(0, offset++);

      Buffer.from(filterStr).copy(packet, offset);

      try {
        socket.send(packet);
      } catch (err) {
        clearTimeout(timeout);
        socket.close();
        reject(err);
      }
    };

    socket.connect(masterPort, masterHost, () => {
      sendQuery();
    });
  });
}

let serverCache = {
  data: null,
  timestamp: 0,
  ttl: 60000, // 1 minute cache
};

async function getServersFromSteamAPI(apiKey, useCache = true) {
  if (!apiKey) {
    throw new Error('Steam API Key not configured in Settings');
  }

  if (useCache && serverCache.data && (Date.now() - serverCache.timestamp) < serverCache.ttl) {
    log.debug(`Returning ${serverCache.data.length} servers from cache`);
    return serverCache.data;
  }

  const allServers = new Map();

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

  const results = await Promise.all(baseFilters.map(fetchWithFilter));

  for (const servers of results) {
    for (const server of servers) {
      if (server.addr) {
        allServers.set(server.addr, server);
      }
    }
  }

  log.info(`Steam API returned ${allServers.size} unique servers`);

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

export function deriveEmptyReason({ source, serversFound, mastersReachable, mastersListedCount }) {
  if (source !== 'master_server' || serversFound > 0) return undefined;
  if (!mastersReachable) return 'master-unreachable';
  return mastersListedCount > 0 ? 'no-servers-responded' : 'no-servers-listed';
}

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

export function selectMasterServersToQuery(masterServers) {
  const queryable = masterServers.filter((s) => !isPrivateIp(s.ip));
  return {
    toQuery: queryable.slice(0, MAX_MASTER_SERVERS_TO_QUERY),
    privateFilteredCount: masterServers.length - queryable.length,
    truncated: queryable.length > MAX_MASTER_SERVERS_TO_QUERY,
  };
}

export function deriveSteamApiFailureReason({ steamApiError, serversFound }) {
  if (!steamApiError || serversFound > 0) return undefined;
  return sanitizeError(steamApiError);
}

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

    if (steamApiKey) {
      try {
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

    let mastersReachable = false;
    let mastersListedCount = 0;
    let mastersPrivateFilteredCount = 0;
    let mastersQueriedCount = 0;
    let mastersTruncated = false;
    if (servers.length === 0) {
      source = 'master_server';
      try {
        const filter = `\\appid\\${PZ_APP_ID}`;

        for (const master of MASTER_SERVERS) {
          try {
            const masterServers = await queryMasterServer(master.host, master.port, 0xFF, filter);
            mastersReachable = true;
            mastersListedCount += masterServers.length;

            const { toQuery: serversToQuery, privateFilteredCount, truncated } =
              selectMasterServersToQuery(masterServers);
            mastersPrivateFilteredCount += privateFilteredCount;
            if (truncated) mastersTruncated = true;
            mastersQueriedCount += serversToQuery.length;

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

    servers.sort((a, b) => (b.players || 0) - (a.players || 0));

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

router.get('/query', async (req, res) => {
  const { ip, port } = req.query;
  log.info(`GET /query: ip=${ip}, port=${port}`);

  if (!ip || !port) {
    return res.status(400).json({
      success: false,
      error: 'IP and port are required',
    });
  }

  if (!validateQueryIp(ip)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid or disallowed IP address',
    });
  }

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

router.get('/ping', async (req, res) => {
  const { ip, port } = req.query;

  if (!ip || !port) {
    return res.status(400).json({
      success: false,
      error: 'IP and port are required',
    });
  }

  if (!validateQueryIp(ip)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid or disallowed IP address',
    });
  }

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

router.get('/debug', async (req, res) => {
  try {
    const steamApiKey = await getSteamApiKey();
    if (!steamApiKey) {
      return res.status(400).json({ error: 'Steam API key not configured' });
    }

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
