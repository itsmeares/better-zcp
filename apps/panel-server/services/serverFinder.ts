import dgram from "dgram";
import { createLogger } from "../utils/logger.ts";
import { getSteamApiKey } from "./steamApiKey.ts";
import { sanitizeError } from "../utils/sanitize.ts";

const log = createLogger("API:Finder");

export type QueryFailureReason = keyof typeof QUERY_FAILURE_MESSAGES;

export type FinderServer = {
  players?: number;
  maxPlayers?: number;
  [key: string]: string | number | boolean | null | undefined | string[];
};

export type A2SInfo = FinderServer & {
  protocol: number;
  name: string;
  map: string;
  folder: string;
  game: string;
  appId: number;
  players: number;
  maxPlayers: number;
  bots: number;
  serverType: string;
  environment: string;
  visibility: number;
  isPrivate: boolean;
  vac: number;
  version: string;
  ip?: string;
  port?: number;
  queryPort?: number;
  gamePort?: number;
  sourceTvPort?: number;
  sourceTvName?: string;
  keywords?: string;
};

type MasterServerEntry = { ip: string; port: number };
type SteamServer = {
  addr?: string;
  gametype?: string;
  name?: string;
  gameport?: unknown;
  players?: number;
  max_players?: number;
  map?: string;
  secure?: boolean;
  password?: boolean;
  os?: string;
  dedicated?: boolean;
  bots?: number;
  steamid?: string;
  gamedir?: string;
};

export type FinderResponse = {
  success: true;
  source: string;
  cached: boolean;
  count: number;
  totalPlayers: number;
  activeServers: number;
  totalCapacity: number;
  servers: FinderServer[];
  apiKeyConfigured: boolean;
  emptyReason?: string;
  masterDiscovery?: Record<string, unknown>;
  steamApiFailure?: string;
};

export const QUERY_FAILURE_MESSAGES = {
  timeout: "Server did not respond (timed out)",
  "socket-error": "Could not reach the server (network error)",
  "unparseable-response":
    "Server responded with data the panel could not parse",
};

const PZ_APP_ID = 108600;
const MASTER_SERVERS = [{ host: "hl2master.steampowered.com", port: 27011 }];
const QUERY_TIMEOUT = 10000;
const SERVER_QUERY_TIMEOUT = 3000;
const MAX_MASTER_SERVERS_TO_QUERY = 200;

export function isPrivateIp(ip: unknown): boolean {
  if (typeof ip !== "string") return true;
  const normalized = ip.trim();
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.some((part) => part < 0 || part > 255 || Number.isNaN(part)))
    return true;
  const [first, second] = parts;
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first >= 224) return true;
  return false;
}

export function validateQueryIp(ip: unknown): ip is string {
  return typeof ip === "string" && ip.length > 0 && !isPrivateIp(ip);
}

export function parseQueryPort(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 && value <= 65535
      ? value
      : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function buildA2SInfoQuery(challenge: Buffer | null = null): Buffer {
  const base = Buffer.from([
    0xff,
    0xff,
    0xff,
    0xff,
    0x54,
    ...Buffer.from("Source Engine Query\0"),
  ]);
  return challenge ? Buffer.concat([base, challenge]) : base;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function queryServerInfo(
  ip: string,
  port: number,
  onFailureReason?: (reason: QueryFailureReason) => void,
): Promise<A2SInfo | null> {
  return new Promise<A2SInfo | null>((resolve) => {
    const socket = dgram.createSocket("udp4");
    let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      socket.close();
      onFailureReason?.("timeout");
      resolve(null);
    }, SERVER_QUERY_TIMEOUT);
    let challengeRetried = false;

    socket.on("error", () => {
      if (timeout) clearTimeout(timeout);
      socket.close();
      onFailureReason?.("socket-error");
      resolve(null);
    });

    socket.on("message", (msg) => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      if (msg.length >= 9 && msg.readUInt8(4) === 0x41 && !challengeRetried) {
        challengeRetried = true;
        const challenge = msg.subarray(5, 9);
        timeout = setTimeout(() => {
          socket.close();
          onFailureReason?.("timeout");
          resolve(null);
        }, SERVER_QUERY_TIMEOUT);
        try {
          socket.send(buildA2SInfoQuery(challenge));
        } catch {
          clearTimeout(timeout);
          socket.close();
          onFailureReason?.("socket-error");
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
      } catch {
        socket.close();
        onFailureReason?.("unparseable-response");
        resolve(null);
      }
    });

    socket.connect(port, ip, () => {
      try {
        socket.send(buildA2SInfoQuery());
      } catch {
        if (timeout) clearTimeout(timeout);
        socket.close();
        onFailureReason?.("socket-error");
        resolve(null);
      }
    });
  });
}

function parseA2SInfoResponse(buffer: Buffer): A2SInfo {
  let offset = 4;
  const header = buffer.readUInt8(offset++);
  if (header === 0x41) throw new Error("Challenge required");
  if (header !== 0x49 && header !== 0x6d)
    throw new Error("Invalid response header");

  const info = {} as A2SInfo;
  info.protocol = buffer.readUInt8(offset++);

  const readString = () => {
    const start = offset;
    while (buffer[offset] !== 0 && offset < buffer.length) offset++;
    const value = buffer.toString("utf8", start, offset);
    offset++;
    return value;
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
    if (edf & 0x10) offset += 8;
    if (edf & 0x40) {
      info.sourceTvPort = buffer.readUInt16LE(offset);
      offset += 2;
      info.sourceTvName = readString();
    }
    if (edf & 0x20) info.keywords = readString();
    if (edf & 0x01) offset += 8;
  }

  return info;
}

export async function queryMasterServer(
  masterHost: string,
  masterPort: number,
  region = 0xff,
  filters = "",
): Promise<MasterServerEntry[]> {
  return new Promise<MasterServerEntry[]>((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const servers: MasterServerEntry[] = [];
    let lastIp = "0.0.0.0";
    let lastPort = 0;

    const timeout = setTimeout(() => {
      socket.close();
      resolve(servers);
    }, QUERY_TIMEOUT);

    socket.on("error", (error) => {
      clearTimeout(timeout);
      socket.close();
      reject(error);
    });

    socket.on("message", (msg) => {
      if (msg.length < 6) return;
      let offset = 6;
      while (offset + 6 <= msg.length) {
        const ip = `${msg[offset]}.${msg[offset + 1]}.${msg[offset + 2]}.${msg[offset + 3]}`;
        const port = msg.readUInt16BE(offset + 4);
        offset += 6;
        if (ip === "0.0.0.0" && port === 0) {
          clearTimeout(timeout);
          socket.close();
          resolve(servers);
          return;
        }
        servers.push({ ip, port });
        lastIp = ip;
        lastPort = port;
      }
      if (servers.length > 0) sendQuery(lastIp, lastPort);
    });

    const sendQuery = (seedIp = "0.0.0.0", seedPort = 0) => {
      const seedAddr = `${seedIp}:${seedPort}`;
      const filterStr = `${filters}\0`;
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
      } catch (error) {
        clearTimeout(timeout);
        socket.close();
        reject(error);
      }
    };

    socket.connect(masterPort, masterHost, () => sendQuery());
  });
}

let serverCache: {
  data: SteamServer[] | null;
  timestamp: number;
  ttl: number;
} = { data: null, timestamp: 0, ttl: 60000 };

export async function getServersFromSteamAPI(
  apiKey: string,
  useCache = true,
): Promise<SteamServer[]> {
  if (!apiKey) throw new Error("Steam API Key not configured in Settings");
  if (
    useCache &&
    serverCache.data &&
    Date.now() - serverCache.timestamp < serverCache.ttl
  ) {
    log.debug(`Returning ${serverCache.data.length} servers from cache`);
    return serverCache.data;
  }

  const baseFilters = [
    `\\appid\\${PZ_APP_ID}`,
    `\\appid\\${PZ_APP_ID}\\white\\1`,
    `\\appid\\${PZ_APP_ID}\\full\\1`,
  ];
  const allServers = new Map<string, SteamServer>();
  const fetchWithFilter = async (filter: string): Promise<SteamServer[]> => {
    try {
      const url = `https://api.steampowered.com/IGameServersService/GetServerList/v1/?key=${apiKey}&filter=${encodeURIComponent(filter)}&limit=10000`;
      const response = await fetch(url);
      if (!response.ok) {
        log.warn(
          `Steam API request failed for filter ${filter}: ${response.status}`,
        );
        return [];
      }
      const data = (await response.json()) as {
        response?: { servers?: SteamServer[] };
      };
      return data.response?.servers || [];
    } catch (error) {
      log.warn(
        `Steam API request failed for filter ${filter}:`,
        errorMessage(error),
      );
      return [];
    }
  };

  const results = await Promise.all(baseFilters.map(fetchWithFilter));
  for (const servers of results) {
    for (const server of servers) {
      if (server.addr) allServers.set(server.addr, server);
    }
  }

  const serverArray = Array.from(allServers.values());
  log.info(`Steam API returned ${serverArray.length} unique servers`);
  serverCache = { data: serverArray, timestamp: Date.now(), ttl: 60000 };
  return serverArray;
}

export function mapSteamServer(server: SteamServer): FinderServer {
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
    gamePort: server.gameport as FinderServer[string],
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

export function deriveEmptyReason({
  source,
  serversFound,
  mastersReachable,
  mastersListedCount,
}: {
  source: string;
  serversFound: number;
  mastersReachable: boolean;
  mastersListedCount: number;
}): string | undefined {
  if (source !== "master_server" || serversFound > 0) return undefined;
  if (!mastersReachable) return "master-unreachable";
  return mastersListedCount > 0 ? "no-servers-responded" : "no-servers-listed";
}

export function deriveMasterDiscoveryStats({
  source,
  mastersListedCount,
  mastersPrivateFilteredCount,
  mastersQueriedCount,
  mastersTruncated,
}: {
  source: string;
  mastersListedCount: number;
  mastersPrivateFilteredCount: number;
  mastersQueriedCount: number;
  mastersTruncated: boolean;
}): Record<string, unknown> | undefined {
  if (source !== "master_server") return undefined;
  return {
    listed: mastersListedCount,
    privateFiltered: mastersPrivateFilteredCount,
    queried: mastersQueriedCount,
    truncated: mastersTruncated,
  };
}

export function selectMasterServersToQuery(
  masterServers: MasterServerEntry[],
): {
  toQuery: MasterServerEntry[];
  privateFilteredCount: number;
  truncated: boolean;
} {
  const queryable = masterServers.filter((server) => !isPrivateIp(server.ip));
  return {
    toQuery: queryable.slice(0, MAX_MASTER_SERVERS_TO_QUERY),
    privateFilteredCount: masterServers.length - queryable.length,
    truncated: queryable.length > MAX_MASTER_SERVERS_TO_QUERY,
  };
}

export function deriveSteamApiFailureReason({
  steamApiError,
  serversFound,
}: {
  steamApiError: string | null;
  serversFound: number;
}): string | undefined {
  if (!steamApiError || serversFound > 0) return undefined;
  return sanitizeError(steamApiError);
}

export async function getServerFinderResponse(
  forceRefresh = false,
): Promise<FinderResponse> {
  let servers: FinderServer[] = [];
  let source = "steam_api";
  const rawSteamApiKey = await getSteamApiKey();
  const steamApiKey =
    typeof rawSteamApiKey === "string" ? rawSteamApiKey : null;
  const apiKeyConfigured = Boolean(steamApiKey);
  const cached =
    !forceRefresh &&
    serverCache.data !== null &&
    Date.now() - serverCache.timestamp < serverCache.ttl;
  let steamApiError: string | null = null;

  if (steamApiKey) {
    try {
      const apiServers = await getServersFromSteamAPI(
        steamApiKey,
        !forceRefresh,
      );
      servers = apiServers.map(mapSteamServer);
      log.info(`Found ${servers.length} PZ servers via Steam API`);
    } catch (error) {
      log.warn(
        "Steam API failed, trying master server query:",
        errorMessage(error),
      );
      steamApiError = errorMessage(error);
      source = "master_server";
    }
  }

  let mastersReachable = false;
  let mastersListedCount = 0;
  let mastersPrivateFilteredCount = 0;
  let mastersQueriedCount = 0;
  let mastersTruncated = false;
  if (servers.length === 0) {
    source = "master_server";
    try {
      for (const master of MASTER_SERVERS) {
        try {
          const masterServers = await queryMasterServer(
            master.host,
            master.port,
            0xff,
            `\\appid\\${PZ_APP_ID}`,
          );
          mastersReachable = true;
          mastersListedCount += masterServers.length;
          const { toQuery, privateFilteredCount, truncated } =
            selectMasterServersToQuery(masterServers);
          mastersPrivateFilteredCount += privateFilteredCount;
          if (truncated) mastersTruncated = true;
          mastersQueriedCount += toQuery.length;

          for (let i = 0; i < toQuery.length; i += 50) {
            const results = await Promise.all(
              toQuery
                .slice(i, i + 50)
                .map((server) => queryServerInfo(server.ip, server.port)),
            );
            servers.push(
              ...results.filter((result): result is A2SInfo => result !== null),
            );
          }
          if (servers.length > 0) break;
        } catch (error) {
          log.warn(
            `Master server ${master.host} query failed:`,
            errorMessage(error),
          );
        }
      }
      log.info(`Found ${servers.length} PZ servers via master server`);
    } catch (error) {
      log.error("Master server query failed:", errorMessage(error));
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
  return {
    success: true,
    source,
    cached,
    count: servers.length,
    totalPlayers: servers.reduce(
      (sum, server) => sum + (server.players || 0),
      0,
    ),
    activeServers: servers.filter((server) => (server.players ?? 0) > 0).length,
    totalCapacity: servers.reduce(
      (sum, server) => sum + (server.maxPlayers || 0),
      0,
    ),
    servers,
    apiKeyConfigured,
    emptyReason,
    masterDiscovery,
    steamApiFailure,
  };
}

export async function queryFinderServer(ip: string, port: number) {
  let reason: QueryFailureReason = "timeout";
  const info = await queryServerInfo(ip, port, (failureReason) => {
    reason = failureReason;
  });
  return { info, reason };
}

export async function pingFinderServer(ip: string, port: number) {
  const startTime = Date.now();
  try {
    const { info, reason } = await queryFinderServer(ip, port);
    if (!info) return { success: true, ping: null, online: false, reason };
    return { success: true, ping: Date.now() - startTime, online: true };
  } catch {
    return { success: true, ping: null, online: false };
  }
}

export async function getServerFinderDebug() {
  const steamApiKey = await getSteamApiKey();
  if (!steamApiKey)
    throw Object.assign(new Error("Steam API key not configured"), {
      status: 400,
    });
  const url = `https://api.steampowered.com/IGameServersService/GetServerList/v1/?key=${steamApiKey}&filter=\\appid\\${PZ_APP_ID}\\noplayers\\0&limit=10`;
  const response = await fetch(url);
  if (!response.ok)
    throw Object.assign(new Error(`Steam API error: ${response.status}`), {
      status: 500,
    });
  const data = (await response.json()) as {
    response?: { servers?: SteamServer[] };
  };
  const servers = data.response?.servers || [];
  return {
    success: true,
    count: servers.length,
    rawServers: servers,
    fieldNames: servers.length > 0 ? Object.keys(servers[0]) : [],
  };
}
