import express from 'express';
import { createLogger } from '../utils/logger.js';
const log = createLogger('API:RCON');
import { getCommandHistory } from '../database/init.js';
import { PZ_COMMANDS } from '../utils/commands.ts';
import {
  parseBoundedInteger,
  parseClampedInteger,
} from '../utils/queryNumbers.ts';
import { sanitizeError } from '../utils/sanitize.ts';
import { redactRconCommandSecrets } from '../utils/rconCommandRedaction.ts';
import {
  testRconConnection,
  checkTcpReachable,
  RCON_UNREACHABLE_DETAIL,
  RCON_AUTH_FAILED_DETAIL,
  RCON_USER_ACTION_TIMEOUT_MS,
} from '../services/rcon.js';
import { requirePermission } from '../services/permissions.js';
import { ErrorCode } from '../utils/errorCodes.js';

const router = express.Router();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateTestInput(
  host: unknown,
  port: unknown,
  password: unknown,
): string | null {
  if (typeof host !== 'string' || host.length > 255 || !/^[a-zA-Z0-9.-]+$/.test(host)) {
    return 'Invalid host format';
  }
  const portNum = parseBoundedInteger(port, null, 1, 65535);
  if (portNum === null) {
    return 'Invalid port (1-65535)';
  }
  if (password !== undefined && (typeof password !== 'string' || password.length > 256)) {
    return 'Invalid password format';
  }
  return null;
}

router.post('/execute', requirePermission('rcon.execute'), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const command = req.body?.command;
    log.info(`POST /execute: ${typeof command === 'string' ? String(redactRconCommandSecrets(command)).substring(0, 100) : ''}`);

    if (!command) {
      return res.status(400).json({ error: 'Command is required', code: ErrorCode.RCON_COMMAND_REQUIRED });
    }

    if (typeof command !== 'string' || command.length > 2000) {
      return res.status(400).json({ error: 'Invalid command (max 2000 characters)', code: ErrorCode.RCON_COMMAND_INVALID });
    }

    const result = await rconService.execute(command);

    const io = req.app.get('io');
    if (io) io.to('rcon-live').emit('rcon:response', {
      command: redactRconCommandSecrets(command),
      response: redactRconCommandSecrets(result.response || result.error),
      success: result.success,
      timestamp: new Date().toISOString()
    });

    res.json(result);
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`RCON execute failed: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

router.get('/status', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const config = rconService.getConfig();
    res.json(config);
  } catch (error: unknown) {
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post('/connect', requirePermission('rcon.execute'), async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, error: 'Request body must be an object' });
    }
    const rconService = req.app.get('rconService');
    const { host, port, password } = req.body;
    log.info(`POST /connect (host=${host || 'default'}, port=${port || 'default'}, password=${password ? '***' : 'none'})`);

    if (host !== undefined || port !== undefined) {
      let canOverrideTarget = false;
      await requirePermission('servers.manage')(req, res, () => {
        canOverrideTarget = true;
      });
      if (!canOverrideTarget) return;
    }

    if (host !== undefined) {
      if (typeof host !== 'string' || host.length > 255 || !/^[a-zA-Z0-9.-]+$/.test(host)) {
        return res.status(400).json({ success: false, error: 'Invalid host format', code: ErrorCode.RCON_INVALID_HOST });
      }
    }

    let normalizedPort: number | undefined;
    if (port !== undefined) {
      const parsedPort = parseBoundedInteger(port, null, 1, 65535);
      if (parsedPort === null) {
        return res.status(400).json({ success: false, error: 'Invalid port (1-65535)', code: ErrorCode.RCON_INVALID_PORT });
      }
      normalizedPort = parsedPort;
    }

    if (password !== undefined) {
      if (typeof password !== 'string' || password.length > 256) {
        return res.status(400).json({ success: false, error: 'Invalid password format', code: ErrorCode.RCON_INVALID_PASSWORD });
      }
    }

    if (host !== undefined || port !== undefined || password !== undefined) {
      rconService.updateConfig(host, normalizedPort, password);
    }

    let connected;
    try {
      connected = await rconService.connect();
    } catch {
      connected = false;
    }

    if (connected) {
      return res.json({ success: true, message: 'Connected to RCON' });
    }

    const { host: configuredHost, port: configuredPort } = rconService.getConfig();
    const reachable = await checkTcpReachable(configuredHost, configuredPort, RCON_USER_ACTION_TIMEOUT_MS);
    if (!reachable) {
      return res.status(503).json({
        success: false,
        error: RCON_UNREACHABLE_DETAIL,
        code: ErrorCode.RCON_CONNECT_UNREACHABLE,
      });
    }
    return res.status(503).json({
      success: false,
      error: RCON_AUTH_FAILED_DETAIL,
      code: ErrorCode.RCON_CONNECT_AUTH_FAILED,
    });
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`RCON connect failed: ${message}`);
    const rconService = req.app.get('rconService');
    const friendlyError = rconService.getUserFriendlyError(message);
    res.status(500).json({ success: false, error: friendlyError });
  }
});

router.post('/test', requirePermission('rcon.execute'), requirePermission('servers.manage'), async (req, res) => {
  try {
    const { host, port, password } = req.body || {};
    log.info(redactRconCommandSecrets(`POST /test (host=${host || 'none'}, port=${port || 'none'})`));

    const validationError = validateTestInput(host, port, password);
    if (validationError) {
      return res.status(400).json({ success: false, error: 'invalid_input', detail: validationError });
    }

    const result = await testRconConnection({
      host,
      port: parseBoundedInteger(port, null, 1, 65535),
      password,
    });
    res.json(result);
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`RCON test failed: ${message}`);
    res.status(500).json({ success: false, error: 'internal_error', detail: sanitizeError(message) });
  }
});

router.get('/health', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const health = await rconService.healthCheck();
    if (health.healthy) {
      res.json({ success: true, ...health });
    } else {
      res.status(503).json({ success: false, ...health });
    }
  } catch (error: unknown) {
    res.status(500).json({ success: false, reason: sanitizeError(errorMessage(error)) });
  }
});

router.post('/disconnect', requirePermission('rcon.execute'), async (req, res) => {
  try {
    log.info('POST /disconnect');
    const rconService = req.app.get('rconService');
    await rconService.disconnect();
    res.json({ success: true, message: 'Disconnected from RCON' });
  } catch (error: unknown) {
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get('/history', requirePermission('rcon.execute'), async (req, res) => {
  try {
    const limit = parseClampedInteger(req.query.limit, 100, 1, 1000);
    const history = await getCommandHistory(limit);
    res.json({ history });
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to get command history: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

router.get('/commands', (req, res) => {
  res.json({ commands: PZ_COMMANDS });
});

router.get('/commands/:category', (req, res) => {
  const { category } = req.params;
  const commands = PZ_COMMANDS as Record<string, { category?: string; [key: string]: unknown }>;
  const filtered: Record<string, unknown> = Object.entries(commands)
    .filter(([_, cmd]) => cmd.category === category)
    .reduce((acc, [key, cmd]) => {
      acc[key] = cmd;
      return acc;
    }, {} as Record<string, unknown>);

  res.json({ commands: filtered });
});

export default router;
