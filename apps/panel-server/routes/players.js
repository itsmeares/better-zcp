import { parseClampedInteger } from "../utils/queryNumbers.ts";
import express from 'express';
import { createLogger } from '../utils/logger.js';
const log = createLogger('API:Players');
import {
  logPlayerAction,
  getPlayerLogs,
  getPlayerNotes,
  getPlayerNote,
  upsertPlayerNote,
  deletePlayerNote,
  getPlayerStats,
  getPlayerStat,
  getSteamIdBans,
  addSteamIdBan,
  removeSteamIdBan,
  getActiveServer,
} from '../database/init.js';
import { VEHICLES, PERKS, PERK_CATALOG, ACCESS_LEVELS } from '../utils/commands.ts';
import { sanitizeError } from '../utils/sanitize.ts';
import bridge from '../services/panelBridge.js';
import { listWhitelistAccounts, listServerRoleNames } from '../utils/whitelistDb.js';
import { requirePermission } from '../services/permissions.js';
import { ErrorCode } from '../utils/errorCodes.ts';

const router = express.Router();


const MAX_EXPORT_FILE_BYTES = 5 * 1024 * 1024;

export function parsePlayerExportFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error('Export not found');
  }

  if (stat.size > MAX_EXPORT_FILE_BYTES) {
    throw new Error('Export file is too large');
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new Error('Could not read export file');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON export file');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid export structure');
  }

  return parsed;
}

const USERNAME_REGEX = /^[^\x00-\x1F\x7F"\\]{1,64}$/;
const SAFE_TEXT_REGEX = /^[a-zA-Z0-9\s.,!?'":;()@#&+=%_\-\u00C0-\u024F]{0,256}$/;
const ITEM_REGEX = /^[A-Za-z0-9_]+\.[A-Za-z0-9_&#+.\-]+$/;

function isValidUsername(username) {
  if (typeof username !== 'string') return false;
  const trimmed = username.trim();
  return trimmed.length > 0 && USERNAME_REGEX.test(trimmed);
}

function isValidText(text) {
  return typeof text === 'string' && SAFE_TEXT_REGEX.test(text);
}

function isValidItem(item) {
  return typeof item === 'string' && ITEM_REGEX.test(item);
}

function isValidNumber(num, min = -Infinity, max = Infinity) {
  if (
    num === null ||
    num === undefined ||
    (typeof num === 'string' && num.trim() === '')
  ) {
    return false;
  }
  const n = Number(num);
  return Number.isFinite(n) && n >= min && n <= max;
}

function requireBooleanToggle(value) {
  return typeof value === "boolean";
}

export function normalizePlayerLogLimit(value) {
  return parseClampedInteger(value, 100, 1, 500);
}

async function setPlayerMode(req, bridgeAction, rconMethod, username, enabled) {
  if (bridge.isRunning) {
    const result = await bridge.sendCommand(bridgeAction, { username, enabled: enabled === true });
    return { ...result, via: 'bridge' };
  }
  const result = await req.app.get('rconService')[rconMethod](username, enabled);
  return {
    ...result,
    via: 'rcon',
    warning: 'PanelBridge is offline; this was sent via RCON instead, which reports less detail about the result.',
  };
}

router.get('/activity', requirePermission("players.view"), async (req, res) => {
  try {
    const { player, limit = 100 } = req.query;
    const logs = await getPlayerLogs(
      player || null,
      normalizePlayerLogLimit(limit),
    );
    res.json({ success: true, logs });
  } catch (error) {
    log.error(`Failed to get player activity logs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get('/', requirePermission("players.view"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.getPlayers();

    const io = req.app.get('io');
    if (io && result.success) {
      io.to('players').emit('players:update', result.players);
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to get players: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/kick', requirePermission("players.moderate"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, reason } = req.body || {};

    if (!username) {
      return res.status(400).json({ error: 'Username is required', code: ErrorCode.PLAYERS_USERNAME_REQUIRED });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format', code: ErrorCode.PLAYERS_INVALID_USERNAME });
    }

    if (reason && !isValidText(reason)) {
      return res.status(400).json({ error: 'Invalid reason format', code: ErrorCode.PLAYERS_INVALID_REASON });
    }

    const result = await rconService.kickPlayer(username, reason);
    log.info(`POST /kick: ${username} (reason=${reason || 'none'})`);
    if (result?.success) {
      await logPlayerAction(username, 'kick', reason);
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to kick player: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/ban', requirePermission("players.moderate"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, banIp, reason } = req.body || {};

    if (!username) {
      return res.status(400).json({ error: 'Username is required', code: ErrorCode.PLAYERS_USERNAME_REQUIRED });
    }

    if (banIp !== undefined && typeof banIp !== 'boolean') {
      return res.status(400).json({ error: 'banIp must be a boolean', code: ErrorCode.PLAYERS_INVALID_BAN_IP });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format', code: ErrorCode.PLAYERS_INVALID_USERNAME });
    }

    if (reason && !isValidText(reason)) {
      return res.status(400).json({ error: 'Invalid reason format', code: ErrorCode.PLAYERS_INVALID_REASON });
    }

    const result = await rconService.banPlayer(username, banIp, reason);
    const sentReason = result?.sentReason ?? reason;
    log.info(
      `POST /ban: ${username} (banIp=${banIp}, reason=${sentReason || 'none'}${sentReason !== reason ? ` [requested: ${reason}]` : ''})`,
    );
    if (result?.success) {
      await logPlayerAction(username, 'ban', `IP: ${banIp}, Reason: ${sentReason}`);
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to ban player: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/unban', requirePermission("players.moderate"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username } = req.body || {};

    if (!username) {
      return res.status(400).json({ error: 'Username is required', code: ErrorCode.PLAYERS_USERNAME_REQUIRED });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format', code: ErrorCode.PLAYERS_INVALID_USERNAME });
    }

    const result = await rconService.unbanPlayer(username);
    log.info(`POST /unban: ${username}`);
    if (result?.success) {
      await logPlayerAction(username, 'unban', null);
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to unban player: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/access-level', requirePermission("players.moderate"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, level } = req.body || {};

    if (!username || !level) {
      return res.status(400).json({ error: 'Username and level are required', code: ErrorCode.PLAYERS_ACCESS_LEVEL_FIELDS_REQUIRED });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format', code: ErrorCode.PLAYERS_INVALID_USERNAME });
    }

    const activeServer = await getActiveServer();
    let validLevels = ACCESS_LEVELS;
    if (activeServer && !activeServer.isRemote) {
      const roleResult = await listServerRoleNames(activeServer.zomboidDataPath, activeServer.serverName);
      if (roleResult.available) {
        validLevels = [...roleResult.roleNames, 'none'];
      }
    }

    if (!validLevels.includes(level.toLowerCase())) {
      return res.status(400).json({
        error: `Invalid access level. Valid: ${validLevels.join(', ')}`,
        code: ErrorCode.PLAYERS_INVALID_ACCESS_LEVEL,
        params: { validLevels: validLevels.join(', ') },
      });
    }

    const result = await rconService.setAccessLevel(username, level);
    log.info(`POST /access-level: ${username} → ${level}`);
    if (result?.success) {
      await logPlayerAction(username, 'access_level', level);
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to set access level: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/whitelist/add', requirePermission("players.moderate"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, password } = req.body || {};

    if (!username) {
      return res.status(400).json({ error: 'Username is required', code: ErrorCode.PLAYERS_USERNAME_REQUIRED });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format', code: ErrorCode.PLAYERS_INVALID_USERNAME });
    }
    if (password !== undefined && password !== '' && !/^[a-zA-Z0-9!@#$%^&*_-]{4,64}$/.test(password)) {
      return res.status(400).json({ error: 'Invalid password format', code: ErrorCode.PLAYERS_INVALID_PASSWORD });
    }

    const result = await rconService.addToWhitelist(username, password);
    if (!result?.success) return res.status(400).json(result);
    log.info(`POST /whitelist/add: ${username}`);
    await logPlayerAction(username, 'whitelist_add', null);

    res.json(result);
  } catch (error) {
    log.error(`Failed to add to whitelist: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/whitelist/remove', requirePermission("players.moderate"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username } = req.body || {};

    if (!username) {
      return res.status(400).json({ error: 'Username is required', code: ErrorCode.PLAYERS_USERNAME_REQUIRED });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format', code: ErrorCode.PLAYERS_INVALID_USERNAME });
    }

    const result = await rconService.removeFromWhitelist(username);
    if (!result?.success) return res.status(400).json(result);
    log.info(`POST /whitelist/remove: ${username}`);
    await logPlayerAction(username, 'whitelist_remove', null);

    res.json(result);
  } catch (error) {
    log.error(`Failed to remove from whitelist: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/teleport', requirePermission("players.gm_tools"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    let { player1, player2, x, y, z } = req.body || {};

    if ((x === undefined || y === undefined || z === undefined) && typeof player2 === 'string' && player2.includes(',')) {
      const parts = player2.split(',').map(part => part.trim());
      if (parts.length >= 2) {
        [x, y] = parts;
        z = parts[2] ?? '0';
        player2 = undefined;
      }
    }

    let result;
    if (x !== undefined && y !== undefined && z !== undefined) {
      if (!isValidNumber(x, 0, 24000) || !isValidNumber(y, 0, 24000) || !isValidNumber(z, 0, 8)) {
        return res.status(400).json({ error: 'Invalid coordinates (x/y: 0 to 24000, z: 0 to 8)', code: ErrorCode.PLAYERS_TELEPORT_INVALID_COORDINATES });
      }
      if (player1) {
        log.info(`POST /teleport: ${player1} → coords(${x}, ${y}, ${z}) via PanelBridge`);
        if (!isValidUsername(player1)) {
          return res.status(400).json({ error: 'Invalid player1 username format', code: ErrorCode.PLAYERS_TELEPORT_INVALID_PLAYER1 });
        }
        if (!bridge.isRunning) {
          return res.status(503).json({ error: 'PanelBridge is not running — cannot teleport a player to coordinates without it', code: ErrorCode.PLAYERS_TELEPORT_BRIDGE_OFFLINE });
        }
        result = await bridge.teleportPlayer(player1, Number(x), Number(y), Number(z));
      } else {
        result = await rconService.teleportTo(x, y, z);
      }
    } else if (player1) {
      if (!isValidUsername(player1)) {
        return res.status(400).json({ error: 'Invalid player1 username format', code: ErrorCode.PLAYERS_TELEPORT_INVALID_PLAYER1 });
      }
      if (player2 && !isValidUsername(player2)) {
        return res.status(400).json({ error: 'Invalid player2 username format', code: ErrorCode.PLAYERS_TELEPORT_INVALID_PLAYER2 });
      }
      result = await rconService.teleportPlayer(player1, player2);
    } else {
      return res.status(400).json({ error: 'Player name or coordinates required', code: ErrorCode.PLAYERS_TELEPORT_TARGET_REQUIRED });
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to teleport: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/add-item', requirePermission("players.gm_tools"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, item, count } = req.body || {};

    if (!item) {
      return res.status(400).json({ error: 'Item is required', code: ErrorCode.PLAYERS_ITEM_REQUIRED });
    }

    if (!isValidItem(item)) {
      return res.status(400).json({ error: 'Invalid item format', code: ErrorCode.PLAYERS_INVALID_ITEM });
    }

    if (username && !isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format', code: ErrorCode.PLAYERS_INVALID_USERNAME });
    }

    if (count !== undefined && !isValidNumber(count, 1, 100)) {
      return res.status(400).json({ error: 'Invalid count (1-100)', code: ErrorCode.PLAYERS_INVALID_ITEM_COUNT });
    }
    const itemCount = count !== undefined ? Math.min(Math.floor(Number(count)), 100) : 1;

    if (!username) {
      return res.status(400).json({ error: 'A player must be selected to give items', code: ErrorCode.PLAYERS_ADD_ITEM_TARGET_REQUIRED });
    }

    let result;
    result = await rconService.addItem(username, item, itemCount);
    log.info(`POST /add-item: ${item} x${itemCount} to ${username} via RCON`);
    if (username && result?.success) {
      await logPlayerAction(username, 'add_item', `${item} x${itemCount}`);
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to add item: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/add-xp', requirePermission("players.gm_tools"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, perk, amount } = req.body || {};

    if (!username || !perk || amount === undefined || amount === null) {
      return res.status(400).json({ error: 'Username, perk, and amount are required', code: ErrorCode.PLAYERS_ADD_XP_FIELDS_REQUIRED });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format', code: ErrorCode.PLAYERS_INVALID_USERNAME });
    }

    if (!PERKS.includes(perk)) {
      return res.status(400).json({
        error: `Invalid perk. Valid: ${PERKS.join(', ')}`,
        code: ErrorCode.PLAYERS_INVALID_PERK,
        params: { validPerks: PERKS.join(', ') },
      });
    }

    if (!isValidNumber(amount, 0, 100000)) {
      return res.status(400).json({ error: 'Invalid XP amount (0-100000)', code: ErrorCode.PLAYERS_INVALID_XP_AMOUNT });
    }

    const result = await rconService.addXp(username, perk, amount);
    log.info(`POST /add-xp: ${perk}=${amount} to ${username}`);
    if (result?.success) {
      await logPlayerAction(username, 'add_xp', `${perk}=${amount}`);
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to add XP: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/add-vehicle', requirePermission("players.gm_tools"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { vehicle, username } = req.body || {};

    if (!vehicle) {
      return res.status(400).json({ error: 'Vehicle is required', code: ErrorCode.PLAYERS_VEHICLE_REQUIRED });
    }

    if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(vehicle)) {
      return res.status(400).json({ error: 'Invalid vehicle ID format', code: ErrorCode.PLAYERS_INVALID_VEHICLE_ID });
    }

    if (username && !isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format', code: ErrorCode.PLAYERS_INVALID_USERNAME });
    }

    const result = await rconService.addVehicle(vehicle, username);
    log.info(`POST /add-vehicle: ${vehicle} for ${username || 'self'}`);
    if (username && result?.success) {
      await logPlayerAction(username, 'add_vehicle', vehicle);
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to spawn vehicle: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/add-vehicle-at', requirePermission("players.gm_tools"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { vehicle, x, y, z = 0 } = req.body || {};

    if (!vehicle || !/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(vehicle)) {
      return res.status(400).json({ error: 'Invalid vehicle ID format', code: ErrorCode.PLAYERS_INVALID_VEHICLE_ID });
    }

    if (
      !isValidNumber(x, 0, 24000) ||
      !isValidNumber(y, 0, 24000) ||
      !isValidNumber(z, 0, 8)
    ) {
      return res.status(400).json({ error: 'Invalid map coordinates', code: ErrorCode.PLAYERS_INVALID_MAP_COORDINATES });
    }
    const coordinates = [Number(x), Number(y), Number(z)];

    const result = await rconService.addVehicleAt(vehicle, ...coordinates);
    log.info(`POST /add-vehicle-at: ${vehicle} at ${coordinates.map(Math.floor).join(',')}`);
    res.json(result);
  } catch (error) {
    log.error(`Failed to spawn vehicle at coordinate: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/godmode', requirePermission("players.gm_tools"), async (req, res) => {
  try {
    const { username, enabled } = req.body || {};

    if (!username) {
      return res.status(400).json({ error: 'Username is required', code: ErrorCode.PLAYERS_USERNAME_REQUIRED });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format', code: ErrorCode.PLAYERS_INVALID_USERNAME });
    }
    if (!requireBooleanToggle(enabled)) {
      return res.status(400).json({ error: 'enabled must be a boolean', code: ErrorCode.PLAYERS_INVALID_ENABLED_FLAG });
    }

    const result = await setPlayerMode(req, 'setGodMode', 'setGodMode', username, enabled);
    log.info(`POST /godmode: ${username} → ${enabled ? 'ON' : 'OFF'} via ${result.via}`);
    if (result?.success) {
      await logPlayerAction(username, 'godmode', enabled ? 'enabled' : 'disabled');
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to set godmode: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/invisible', requirePermission("players.gm_tools"), async (req, res) => {
  try {
    const { username, enabled } = req.body || {};

    if (!username) {
      return res.status(400).json({ error: 'Username is required', code: ErrorCode.PLAYERS_USERNAME_REQUIRED });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format', code: ErrorCode.PLAYERS_INVALID_USERNAME });
    }
    if (!requireBooleanToggle(enabled)) {
      return res.status(400).json({ error: 'enabled must be a boolean', code: ErrorCode.PLAYERS_INVALID_ENABLED_FLAG });
    }

    const result = await setPlayerMode(req, 'setInvisible', 'setInvisible', username, enabled);
    log.info(`POST /invisible: ${username} → ${enabled ? 'ON' : 'OFF'} via ${result.via}`);
    if (result?.success) {
      await logPlayerAction(username, 'invisible', enabled ? 'enabled' : 'disabled');
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to set invisible: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/noclip', requirePermission("players.gm_tools"), async (req, res) => {
  try {
    const { username, enabled } = req.body || {};

    if (!username) {
      return res.status(400).json({ error: 'Username is required', code: ErrorCode.PLAYERS_USERNAME_REQUIRED });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format', code: ErrorCode.PLAYERS_INVALID_USERNAME });
    }
    if (!requireBooleanToggle(enabled)) {
      return res.status(400).json({ error: 'enabled must be a boolean', code: ErrorCode.PLAYERS_INVALID_ENABLED_FLAG });
    }

    const result = await setPlayerMode(req, 'setNoclip', 'setNoclip', username, enabled);
    log.info(`POST /noclip: ${username} → ${enabled ? 'ON' : 'OFF'} via ${result.via}`);
    if (result?.success) {
      await logPlayerAction(username, 'noclip', enabled ? 'enabled' : 'disabled');
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to set noclip: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get('/vehicles', requirePermission("players.view"), (req, res) => {
  res.json({ vehicles: VEHICLES });
});

router.get('/perks', requirePermission("players.view"), (req, res) => {
  res.json({ perks: PERKS, catalog: PERK_CATALOG });
});

router.get('/access-levels', requirePermission("players.view"), async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    if (!activeServer || activeServer.isRemote) {
      return res.json({ levels: ACCESS_LEVELS, available: false });
    }

    const result = await listServerRoleNames(activeServer.zomboidDataPath, activeServer.serverName);
    const levels = result.available ? [...result.roleNames, 'none'] : ACCESS_LEVELS;
    res.json({
      levels,
      available: result.available,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  } catch (error) {
    log.error(`Failed to get access levels: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get('/steamid-bans', requirePermission("players.view"), async (req, res) => {
  try {
    const bans = await getSteamIdBans();
    res.json({ bans });
  } catch (error) {
    log.error(`Failed to get SteamID bans: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/banid', requirePermission("players.moderate"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { steamId, reason } = req.body || {};
    const normalizedReason = typeof reason === 'string' ? reason.trim() : '';

    if (!steamId) {
      return res.status(400).json({ error: 'SteamID is required', code: ErrorCode.PLAYERS_STEAMID_REQUIRED });
    }

    if (!/^\d{17}$/.test(steamId)) {
      return res.status(400).json({ error: 'Invalid SteamID format (must be 17 digits)', code: ErrorCode.PLAYERS_INVALID_STEAMID });
    }

    if (normalizedReason && !isValidText(normalizedReason)) {
      return res.status(400).json({ error: 'Invalid reason format', code: ErrorCode.PLAYERS_INVALID_REASON });
    }

    const result = await rconService.banSteamId(steamId);
    log.info(`POST /banid: SteamID ${steamId}`);
    if (result?.success) {
      await addSteamIdBan(steamId, normalizedReason || null);
      await logPlayerAction(steamId, 'banid', normalizedReason || null);
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to ban SteamID: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/unbanid', requirePermission("players.moderate"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { steamId } = req.body || {};

    if (!steamId) {
      return res.status(400).json({ error: 'SteamID is required', code: ErrorCode.PLAYERS_STEAMID_REQUIRED });
    }

    if (!/^\d{17}$/.test(steamId)) {
      return res.status(400).json({ error: 'Invalid SteamID format (must be 17 digits)', code: ErrorCode.PLAYERS_INVALID_STEAMID });
    }

    const result = await rconService.unbanSteamId(steamId);
    log.info(`POST /unbanid: SteamID ${steamId}`);
    if (result?.success) {
      await removeSteamIdBan(steamId);
      await logPlayerAction(steamId, 'unbanid', null);
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to unban SteamID: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/voiceban', requirePermission("players.moderate"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, enabled } = req.body || {};

    if (!username) {
      return res.status(400).json({ error: 'Username is required', code: ErrorCode.PLAYERS_USERNAME_REQUIRED });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format', code: ErrorCode.PLAYERS_INVALID_USERNAME });
    }
    if (!requireBooleanToggle(enabled)) {
      return res.status(400).json({ error: 'enabled must be a boolean', code: ErrorCode.PLAYERS_INVALID_ENABLED_FLAG });
    }

    const result = await rconService.voiceBan(username, enabled);
    log.info(`POST /voiceban: ${username} → ${enabled ? 'ON' : 'OFF'}`);
    if (result?.success) {
      await logPlayerAction(username, 'voiceban', enabled ? 'enabled' : 'disabled');
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to set voice ban: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/adduser', requirePermission("players.moderate"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { username, password } = req.body || {};

    if (!username) {
      return res.status(400).json({ error: 'Username is required', code: ErrorCode.PLAYERS_USERNAME_REQUIRED });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format', code: ErrorCode.PLAYERS_INVALID_USERNAME });
    }

    if (password !== undefined && password !== '' && !/^[a-zA-Z0-9!@#$%^&*_-]{4,64}$/.test(password)) {
      return res.status(400).json({ error: 'Invalid password format', code: ErrorCode.PLAYERS_INVALID_PASSWORD });
    }

    const result = await rconService.addUser(username, password);
    if (!result?.success) return res.status(400).json(result);
    await logPlayerAction(username, 'adduser', null);

    res.json(result);
  } catch (error) {
    log.error(`Failed to add user: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/whitelist/addall', requirePermission("players.moderate"), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const result = await rconService.addAllToWhitelist();

    res.json(result);
  } catch (error) {
    log.error(`Failed to add all to whitelist: ${error.message}`);
    res.status(400).json({ success: false, error: sanitizeError(error.message) });
  }
});

router.post('/whitelist/steamid/add', requirePermission("players.moderate"), async (req, res) => {
  try {
    const { steamId } = req.body || {};
    if (!/^\d{17}$/.test(String(steamId || ''))) {
      return res.status(400).json({ error: 'Invalid SteamID format (must be 17 digits)', code: ErrorCode.PLAYERS_INVALID_STEAMID });
    }
    const result = await req.app.get('rconService').addAllowedSteamId(String(steamId));
    if (!result?.success) return res.status(400).json(result);
    await logPlayerAction(String(steamId), 'whitelist_steamid_add', null);
    res.json(result);
  } catch (error) {
    log.error(`Failed to add allowed SteamID: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/whitelist/steamid/remove', requirePermission("players.moderate"), async (req, res) => {
  try {
    const { steamId } = req.body || {};
    if (!/^\d{17}$/.test(String(steamId || ''))) {
      return res.status(400).json({ error: 'Invalid SteamID format (must be 17 digits)', code: ErrorCode.PLAYERS_INVALID_STEAMID });
    }
    const result = await req.app.get('rconService').removeAllowedSteamId(String(steamId));
    if (!result?.success) return res.status(400).json(result);
    await logPlayerAction(String(steamId), 'whitelist_steamid_remove', null);
    res.json(result);
  } catch (error) {
    log.error(`Failed to remove allowed SteamID: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get('/whitelist', requirePermission("players.view"), async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    if (!activeServer) {
      return res.status(404).json({ error: 'No active server selected', code: ErrorCode.PLAYERS_NO_ACTIVE_SERVER });
    }
    if (activeServer.isRemote) {
      return res.json({
        success: true,
        available: false,
        accounts: [],
        allowedSteamIds: [],
        reason: 'Whitelist roster is not available for remote servers yet',
        server: { id: activeServer.id, name: activeServer.serverName },
      });
    }

    const result = await listWhitelistAccounts(
      activeServer.zomboidDataPath,
      activeServer.serverName,
    );
    res.json({
      success: true,
      ...result,
      server: { id: activeServer.id, name: activeServer.serverName },
    });
  } catch (error) {
    log.error(`Failed to list whitelist accounts: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.get('/notes', requirePermission("players.view"), async (req, res) => {
  try {
    const notes = await getPlayerNotes();
    res.json({ success: true, notes });
  } catch (error) {
    log.error(`Failed to get player notes: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get('/notes/:playerName', requirePermission("players.view"), async (req, res) => {
  try {
    const note = await getPlayerNote(req.params.playerName);
    res.json({ success: true, note });
  } catch (error) {
    log.error(`Failed to get player note: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/notes', requirePermission("players.moderate"), async (req, res) => {
  try {
    const { playerName, note } = req.body || {};
    const tags = req.body.tags || [];

    if (!playerName) {
      return res.status(400).json({ error: 'Player name is required', code: ErrorCode.PLAYERS_NOTE_PLAYER_NAME_REQUIRED });
    }
    if (!isValidUsername(playerName)) {
      return res.status(400).json({ error: 'Invalid player name format', code: ErrorCode.PLAYERS_INVALID_NOTE_PLAYER_NAME });
    }

    if (note !== undefined && note !== null && typeof note !== 'string') {
      return res.status(400).json({ error: 'Note must be text', code: ErrorCode.PLAYERS_NOTE_MUST_BE_TEXT });
    }
    if (typeof note === 'string' && note.length > 10000) {
      return res.status(400).json({ error: 'Note too long (max 10000 characters)', code: ErrorCode.PLAYERS_NOTE_TOO_LONG });
    }

    if (!Array.isArray(tags)) {
      return res.status(400).json({ error: 'Tags must be an array', code: ErrorCode.PLAYERS_NOTE_TAGS_MUST_BE_ARRAY });
    }
    if (tags.some(t => typeof t !== 'string' || t.length > 50)) {
      return res.status(400).json({ error: 'Tags must be strings (max 50 chars each)', code: ErrorCode.PLAYERS_NOTE_INVALID_TAGS });
    }

    const result = await upsertPlayerNote(playerName, note, tags);
    res.json({ success: true, note: result });
  } catch (error) {
    log.error(`Failed to save player note: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete('/notes/:playerName', requirePermission("players.moderate"), async (req, res) => {
  try {
    const success = await deletePlayerNote(req.params.playerName);
    if (!success) {
      return res.status(404).json({
        success: false,
        error: 'Player note not found',
        code: ErrorCode.PLAYERS_NOTE_NOT_FOUND,
      });
    }
    res.json({ success });
  } catch (error) {
    log.error(`Failed to delete player note: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.get('/stats', requirePermission("players.view"), async (req, res) => {
  try {
    const stats = await getPlayerStats();
    res.json({ success: true, stats });
  } catch (error) {
    log.error(`Failed to get player stats: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get('/stats/:playerName', requirePermission("players.view"), async (req, res) => {
  try {
    const stat = await getPlayerStat(req.params.playerName);
    res.json({ success: true, stat });
  } catch (error) {
    log.error(`Failed to get player stat: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

import fs from 'fs';
import path from 'path';
import { getDataPaths } from '../utils/paths.js';

router.get('/exports', requirePermission("players.gm_tools"), async (req, res) => {
  try {
    const { username } = req.query;
    const { dataDir } = getDataPaths();
    const exportsRoot = path.join(dataDir, 'exports');

    if (!fs.existsSync(exportsRoot)) {
      return res.json({ exports: [] });
    }

    const results = [];

    const players = username
      ? [username.replace(/[^a-zA-Z0-9_-]/g, '_')]
      : fs.readdirSync(exportsRoot).filter(f => {
          try { return fs.statSync(path.join(exportsRoot, f)).isDirectory(); } catch { return false; }
        });

    for (const playerDir of players) {
      const dirPath = path.join(exportsRoot, playerDir);
      if (!fs.existsSync(dirPath)) continue;
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json')).sort().reverse();
      for (const file of files) {
        const stat = fs.statSync(path.join(dirPath, file));
        results.push({
          username: playerDir,
          filename: file,
          size: stat.size,
          timestamp: stat.mtime.toISOString(),
        });
      }
    }

    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    res.json({ exports: results });
  } catch (error) {
    log.error(`Failed to list exports: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get('/exports/:username/:filename', requirePermission("players.gm_tools"), async (req, res) => {
  try {
    const { username, filename } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(username) || !/^[a-zA-Z0-9_.-]+\.json$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid parameters', code: ErrorCode.PLAYERS_EXPORT_INVALID_PARAMETERS });
    }

    const { dataDir } = getDataPaths();
    const filePath = path.join(dataDir, 'exports', username, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Export not found', code: ErrorCode.PLAYERS_EXPORT_NOT_FOUND });
    }

    const data = parsePlayerExportFile(filePath);
    res.json(data);
  } catch (error) {
    log.error(`Failed to get export: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete('/exports/:username/:filename', requirePermission("players.gm_tools"), async (req, res) => {
  try {
    const { username, filename } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(username) || !/^[a-zA-Z0-9_.-]+\.json$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid parameters', code: ErrorCode.PLAYERS_EXPORT_INVALID_PARAMETERS });
    }

    const { dataDir } = getDataPaths();
    const filePath = path.join(dataDir, 'exports', username, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Export not found', code: ErrorCode.PLAYERS_EXPORT_NOT_FOUND });
    }

    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (error) {
    log.error(`Failed to delete export: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
