import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import SftpClient from 'ssh2-sftp-client';
import { createLogger } from '../utils/logger.js';
import { getDataPaths } from '../utils/paths.js';
import { ErrorCode } from '../utils/errorCodes.ts';

const log = createLogger('Bridge:SFTP');

const MAX_REMOTE_PATH_LENGTH = 500;

function safeRemotePath(value) {
  if (typeof value !== 'string' || value.length > MAX_REMOTE_PATH_LENGTH || !value.startsWith('/') || value.includes('..') || value.includes('\\') || /[\0\r\n]/.test(value)) {
    throw new Error('Remote bridge path must be an absolute POSIX path without traversal');
  }
  const normalized = value.replace(/\/+$/, '') || '/';
  if (normalized === '/') throw new Error('Remote bridge path must name the PanelBridge server folder, not the filesystem root');
  return normalized;
}

function isMissingRemotePath(error) {
  const message = error?.message || String(error);
  return /no such file|not found|enoent/i.test(message);
}

function isRemoteFile(entryType) {
  return entryType === true || entryType === '-';
}

const SFTP_ERROR_CLASSIFIERS = [
  {
    code: ErrorCode.SFTP_CHROOTED_ACCOUNT,
    guidance:
      'This SFTP account appears to be chrooted. Remove the /home prefix and enter the path exactly as shown in the SFTP client, for example /server-data/lua/panelbridge/<server name>.',
    test: (message) =>
      /chroot|remove the \/home prefix|remote bridge path .*\/home(?:\/|$)/i.test(message) ||
      /mkdir.*permission denied.*\/(?:home|Home)(?:[\s/]|$)/i.test(message),
  },
  {
    code: ErrorCode.SFTP_AUTH_FAILED,
    guidance: 'Verify the SFTP username and password, then confirm the account can log in over port 22.',
    test: (message) =>
      /authentication|auth fail|all configured authentication methods failed|permission denied.*auth|publickey|keyboard-interactive/i.test(message),
  },
  {
    code: ErrorCode.SFTP_PERMISSION_DENIED,
    guidance: 'Give the SFTP account read and write permission for the remote bridge folder and its parent directory.',
    test: (message) => /permission denied|eacces|failure.*mkdir|failure.*put/i.test(message),
  },
  {
    code: ErrorCode.SFTP_REMOTE_PATH_MISSING,
    guidance:
      'Verify the remote bridge folder is the VPS path to Lua/panelbridge/<server name>. The panel will create its inbox and outbox folders after the parent path is correct.',
    test: (message, error) => isMissingRemotePath(error),
  },
  {
    code: ErrorCode.SFTP_PATH_OCCUPIED,
    guidance: 'Remove or rename the directory occupying that bridge file path, then run Verify and prepare SFTP again.',
    test: (message) => /found a directory|non-regular entry|occupied by a directory/i.test(message),
  },
  {
    code: ErrorCode.SFTP_UNREACHABLE,
    guidance: 'Check the SFTP host, port, firewall, and that the hosting provider allows SFTP from this panel computer.',
    test: (message) => /econnrefused|etimedout|timeout|enotfound|ehostunreach|network/i.test(message),
  },
  {
    code: ErrorCode.SFTP_UNKNOWN,
    guidance: 'Run Verify and prepare SFTP again. If it still fails, download a support bundle and include sftp-diagnostics.json.',
    test: () => true,
  },
];

function classifySftpError(error) {
  const message = error?.message || String(error);
  return SFTP_ERROR_CLASSIFIERS.find((entry) => entry.test(message, error));
}

export function classifySftpErrorCode(error) {
  return classifySftpError(error).code;
}

export function getSftpErrorGuidance(error) {
  return classifySftpError(error).guidance;
}

export function formatSftpError(error) {
  const message = error?.message || String(error);
  return `${message} Fix: ${getSftpErrorGuidance(error)}`;
}

export function validateSftpBridgeConfig(config) {
  const host = typeof config?.host === 'string' ? config.host.trim() : '';
  const username = typeof config?.username === 'string' ? config.username.trim() : '';
  const port =
    config?.port === undefined || config?.port === null || config?.port === ""
      ? 22
      : Number(config.port);
  const pollIntervalSeconds =
    config?.pollIntervalSeconds === undefined ||
    config?.pollIntervalSeconds === null ||
    config?.pollIntervalSeconds === ""
      ? 3
      : Number(config.pollIntervalSeconds);
  if (!host || host.length > 253 || /[\s/\\]/.test(host)) throw new Error('A valid SFTP host is required');
  if (!username || username.length > 128 || /[\r\n]/.test(username)) throw new Error('A valid SFTP username is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SFTP port must be between 1 and 65535');
  if (!Number.isInteger(pollIntervalSeconds) || pollIntervalSeconds < 2 || pollIntervalSeconds > 10) {
    throw new Error('SFTP sync interval must be between 2 and 10 seconds');
  }
  return {
    host,
    port,
    username,
    password: typeof config?.password === 'string' ? config.password : '',
    bridgePath: safeRemotePath(config?.bridgePath),
    pollIntervalSeconds,
  };
}

export function getSftpCachePath(config) {
  const key = crypto.createHash('sha256').update(`${config.host}:${config.port}:${config.username}:${config.bridgePath}`).digest('hex').slice(0, 24);
  return path.join(getDataPaths().dataDir, 'panelbridge-sftp-cache', key);
}

const LOG_TAIL_MAX_BYTES = 1024 * 1024;
const LOG_TAIL_DEFAULT_BYTES = 256 * 1024;
const LOG_LIST_MAX = 200;
const LOG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LOG_EXTENSIONS = ['.txt', '.log'];
const REMOTE_DIRECTORY_CHECK_MS = 60000;
const MAX_BRIDGE_FILE_BYTES = 16 * 1024 * 1024;

export function validateSftpLogConfig(config) {
  const host = typeof config?.host === 'string' ? config.host.trim() : '';
  const username = typeof config?.username === 'string' ? config.username.trim() : '';
  const port = Number(config?.port || 22);
  if (!host || host.length > 253 || /[\s/\\]/.test(host)) throw new Error('A valid SFTP host is required');
  if (!username || username.length > 128 || /[\r\n]/.test(username)) throw new Error('A valid SFTP username is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SFTP port must be between 1 and 65535');
  if (!config?.logPath) throw new Error('A remote log folder is required');
  return {
    host,
    port,
    username,
    password: typeof config?.password === 'string' ? config.password : '',
    logPath: safeRemotePath(config.logPath),
  };
}

async function withLogClient(config, handler) {
  const client = new SftpClient('PanelBridgeSftpLogs');
  try {
    await client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      readyTimeout: 10000,
    });
    return await handler(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function listSftpLogs(rawConfig) {
  const config = validateSftpLogConfig(rawConfig);
  return withLogClient(config, async (client) => {
    const entries = await client.list(config.logPath);
    const files = entries
      .filter((entry) => entry.type === '-')
      .filter((entry) => LOG_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext)))
      .map((entry) => ({
        name: entry.name,
        size: entry.size,
        modifiedAt: entry.modifyTime ? new Date(entry.modifyTime).toISOString() : null,
      }))
      .sort((a, b) => (b.modifiedAt || '').localeCompare(a.modifiedAt || ''))
      .slice(0, LOG_LIST_MAX);
    return { logPath: config.logPath, files };
  });
}

export async function readSftpLogTail(rawConfig, fileName, requestedBytes) {
  const config = validateSftpLogConfig(rawConfig);
  if (typeof fileName !== 'string' || !LOG_NAME_PATTERN.test(fileName)) {
    throw new Error('Invalid log file name');
  }
  if (!LOG_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext))) {
    throw new Error('Only .txt and .log files can be read');
  }
  const maxBytes = Math.min(
    Math.max(Number(requestedBytes) || LOG_TAIL_DEFAULT_BYTES, 1024),
    LOG_TAIL_MAX_BYTES,
  );
  const remotePath = `${config.logPath}/${fileName}`;
  return withLogClient(config, async (client) => {
    const stats = await client.stat(remotePath);
    const size = Number(stats?.size) || 0;
    const start = Math.max(0, size - maxBytes);
    const buffer = size === 0
      ? Buffer.alloc(0)
      : await client.get(remotePath, undefined, {
          readStreamOptions: { start, end: Math.max(start, size - 1) },
        });
    const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '');
    return {
      name: fileName,
      size,
      truncated: start > 0,
      bytesReturned: Buffer.byteLength(text),
      content: text,
    };
  });
}

export class PanelBridgeSftpTransport {
  constructor() {
    this.config = null;
    this.cachePath = null;
    this.client = null;
    this.timer = null;
    this.running = false;
    this.syncing = false;
    this.lastSyncAt = null;
    this.lastError = null;
    this.lastLatencyMs = null;
    this.connectionAttempts = 0;
    this.lastConnectedAt = null;
    this.lastDisconnectedAt = null;
    this.lastErrorAt = null;
    this.lastErrorStage = null;
    this.syncAttempts = 0;
    this.failureCount = 0;
    this.recentErrors = [];
    this.lastLoggedError = null;
    this.lastLoggedErrorAt = 0;
    this.nextRemoteDirectoryCheckAt = 0;
    this.transferId = crypto.randomBytes(6).toString('hex');
  }

  async start(config, cachePath) {
    this.config = validateSftpBridgeConfig(config);
    this.cachePath = cachePath;
    fs.mkdirSync(path.join(cachePath, 'inbox'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(cachePath, 'outbox'), { recursive: true, mode: 0o700 });
    this.running = true;
    try {
      await this.ensureRemoteDirectories();
      await this.syncNow(true);
    } catch (error) {
      if (this.lastError !== error.message) this.recordError('startup', error);
      throw error;
    }
    this.timer = setInterval(() => this.syncNow().catch(() => {}), this.config.pollIntervalSeconds * 1000);
    this.timer.unref?.();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.client) {
      await this.client.end().catch(() => {});
      this.client = null;
      this.lastDisconnectedAt = new Date().toISOString();
    }
  }

  async connect() {
    if (this.client) return this.client;
    this.connectionAttempts += 1;
    const client = new SftpClient('PanelBridgeSftp');
    await client.connect({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
      readyTimeout: 10000,
    });
    this.client = client;
    this.lastConnectedAt = new Date().toISOString();
    return client;
  }

  async ensureRemoteDirectories() {
    const client = await this.connect();
    try {
      await client.mkdir(this.config.bridgePath, true);
      await client.mkdir(this.remote('inbox'), true);
      await client.mkdir(this.remote('outbox'), true);
    } catch (error) {
      if (/permission denied|eacces/i.test(error?.message || '')
        && /^\/home(?:\/|$)/i.test(this.config.bridgePath)) {
        throw new Error(`SFTP account rejected remote bridge path ${this.config.bridgePath}; likely chrooted account path. Remove the /home prefix and use the path visible in the SFTP client.`);
      }
      throw error;
    }
    this.nextRemoteDirectoryCheckAt = Date.now() + REMOTE_DIRECTORY_CHECK_MS;
  }

  remote(relativeName) {
    if (!relativeName || relativeName.includes('..') || relativeName.includes('\\')) throw new Error('Invalid remote bridge file path');
    return `${this.config.bridgePath}/${relativeName}`;
  }

  local(relativeName) {
    if (!relativeName || relativeName.includes('..') || relativeName.includes('\\')) throw new Error('Invalid remote bridge file path');
    return path.join(this.cachePath, relativeName);
  }

  async copyRemote(relativeName) {
    const client = await this.connect();
    const remotePath = this.remote(relativeName);
    const entryType = await client.exists(remotePath);
    if (!entryType) return false;
    if (!isRemoteFile(entryType)) {
      throw new Error(`Expected a regular file at remote bridge path ${remotePath}, but found a non-regular entry`);
    }
    const metadata = await client.stat(remotePath);
    const size = Number(metadata?.size);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Remote bridge file ${remotePath} has an invalid size`);
    }
    if (size > MAX_BRIDGE_FILE_BYTES) {
      throw new Error(`Remote bridge file ${remotePath} exceeds the ${MAX_BRIDGE_FILE_BYTES / (1024 * 1024)} MB download limit`);
    }
    const localPath = this.local(relativeName);
    fs.mkdirSync(path.dirname(localPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${localPath}.${this.transferId}.download`;
    await client.fastGet(remotePath, temporaryPath);
    fs.renameSync(temporaryPath, localPath);
    return true;
  }

  async syncModFile(baseName) {
    const suffixed = `${baseName}.txt`;
    if (await this.copyRemote(suffixed)) return suffixed;
    await this.copyRemote(baseName);
    return baseName;
  }

  async syncOutbox() {
    const statePath = path.join(this.cachePath, '.queue-state-node.json');
    let nextSequence = 1;
    try {
      nextSequence = Math.max(1, Number(JSON.parse(fs.readFileSync(statePath, 'utf8')).lastConsumedResultSeq || 0) + 1);
    } catch (_) { /* cache is not initialized yet */ }
    for (let offset = 0; offset < 100; offset++) {
      const sequence = String(nextSequence + offset).padStart(10, '0');
      const jsonName = `outbox/res-${sequence}.json`;
      const txtName = `${jsonName}.txt`;
      const copied = await this.copyRemote(txtName) || await this.copyRemote(jsonName);
      if (!copied) break;
    }
  }

  async uploadInbox() {
    const inbox = path.join(this.cachePath, 'inbox');
    const names = fs.readdirSync(inbox).filter((name) => /^cmd-\d+\.json$/.test(name)).sort();
    for (const name of names) {
      const remotePath = this.remote(`inbox/${name}`);
      const client = await this.connect();
      const entryType = await client.exists(remotePath);
      if (isRemoteFile(entryType)) continue;
      if (entryType) {
        throw new Error(`Remote command path ${remotePath} is occupied by a directory`);
      }
      const temporaryRemotePath = `${remotePath}.${this.transferId}.uploading`;
      const uploadAtomically = async () => {
        try {
          await client.fastPut(path.join(inbox, name), temporaryRemotePath);
          await client.rename(temporaryRemotePath, remotePath);
        } catch (error) {
          await client.delete(temporaryRemotePath).catch(() => {});
          throw error;
        }
      };
      try {
        await uploadAtomically();
      } catch (error) {
        if (!isMissingRemotePath(error)) throw error;
        await this.ensureRemoteDirectories();
        await uploadAtomically();
      }
    }
  }

  readLocalQueueStateNodeSnapshot() {
    if (!this.cachePath) return null;
    const statePath = path.join(this.cachePath, '.queue-state-node.json');
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  async uploadQueueStateNode(stateSnapshot) {
    const remotePath = this.remote('.queue-state-node.json');
    const client = await this.connect();
    const entryType = await client.exists(remotePath);
    if (entryType && !isRemoteFile(entryType)) {
      throw new Error(`Remote queue state path ${remotePath} is occupied by a directory`);
    }
    const buffer = Buffer.from(JSON.stringify(stateSnapshot));
    const temporaryRemotePath = `${remotePath}.${this.transferId}.uploading`;
    const uploadOnce = async () => {
      try {
        await client.put(buffer, temporaryRemotePath);
        await client.rename(temporaryRemotePath, remotePath);
      } catch (error) {
        await client.delete(temporaryRemotePath).catch(() => {});
        throw error;
      }
    };
    try {
      await uploadOnce();
    } catch (error) {
      if (!isMissingRemotePath(error)) throw error;
      await this.ensureRemoteDirectories();
      await uploadOnce();
    }
  }

  async syncNow(throwOnError = false) {
    if (!this.running || this.syncing) return;
    this.syncing = true;
    this.syncAttempts += 1;
    const startedAt = Date.now();
    try {
      if (Date.now() >= this.nextRemoteDirectoryCheckAt) {
        await this.ensureRemoteDirectories();
      }
      const queueStateSnapshot = this.readLocalQueueStateNodeSnapshot();
      await this.uploadInbox();
      if (queueStateSnapshot) {
        await this.uploadQueueStateNode(queueStateSnapshot);
      }
      await this.syncModFile('status.json');
      await this.syncModFile('queue-state-lua.json');
      await this.syncOutbox();
      this.lastSyncAt = Date.now();
      this.lastLatencyMs = this.lastSyncAt - startedAt;
      this.lastError = null;
    } catch (error) {
      this.recordError('sync', error);
      if (this.client) await this.client.end().catch(() => {});
      this.client = null;
      this.lastDisconnectedAt = new Date().toISOString();
      if (throwOnError) throw error;
    } finally {
      this.syncing = false;
    }
  }

  recordError(stage, error) {
    const message = error?.message || String(error);
    const timestamp = new Date().toISOString();
    this.failureCount += 1;
    this.lastError = message;
    this.lastErrorAt = timestamp;
    this.lastErrorStage = stage;
    this.recentErrors.push({ stage, message, timestamp });
    if (this.recentErrors.length > 20) this.recentErrors.shift();

    const now = Date.now();
    if (message !== this.lastLoggedError || now - this.lastLoggedErrorAt >= 60000) {
      log.warn(`SFTP ${stage} failed: ${message}`);
      this.lastLoggedError = message;
      this.lastLoggedErrorAt = now;
    }
  }

  getStatus() {
    return {
      type: 'sftp',
      running: this.running,
      cachePath: this.cachePath,
      lastSyncAt: this.lastSyncAt,
      lastLatencyMs: this.lastLatencyMs,
      lastError: this.lastError,
      lastErrorGuidance: this.lastError ? getSftpErrorGuidance({ message: this.lastError }) : null,
      lastErrorCode: this.lastError ? classifySftpErrorCode({ message: this.lastError }) : null,
      pollIntervalSeconds: this.config?.pollIntervalSeconds ?? null,
      remotePath: this.config?.bridgePath ?? null,
      remoteDirectories: this.config ? {
        bridge: this.config.bridgePath,
        inbox: `${this.config.bridgePath}/inbox`,
        outbox: `${this.config.bridgePath}/outbox`,
      } : null,
      diagnostics: {
        connected: Boolean(this.client),
        connectionAttempts: this.connectionAttempts,
        lastConnectedAt: this.lastConnectedAt,
        lastDisconnectedAt: this.lastDisconnectedAt,
        syncAttempts: this.syncAttempts,
        failureCount: this.failureCount,
        lastErrorAt: this.lastErrorAt,
        lastErrorStage: this.lastErrorStage,
        recentErrors: this.recentErrors.slice(-20),
      },
    };
  }
}

export async function testSftpBridge(config) {
  const validated = validateSftpBridgeConfig(config);
  const client = new SftpClient('PanelBridgeSftpTest');
  const startedAt = Date.now();
  try {
    await client.connect({ host: validated.host, port: validated.port, username: validated.username, password: validated.password, readyTimeout: 10000 });
    await client.mkdir(validated.bridgePath, true);
    await client.mkdir(`${validated.bridgePath}/inbox`, true);
    await client.mkdir(`${validated.bridgePath}/outbox`, true);
    const statusExists = isRemoteFile(await client.exists(`${validated.bridgePath}/status.json.txt`))
      || isRemoteFile(await client.exists(`${validated.bridgePath}/status.json`));
    return {
      success: true,
      statusExists,
      foldersReady: true,
      latencyMs: Date.now() - startedAt,
      nextStep: statusExists
        ? 'The remote bridge is ready. Start the SFTP bridge.'
        : 'Folders are ready. Start or restart the PZ server with PanelBridge.lua installed and DoLuaChecksum=false to create status.json.',
    };
  } finally {
    await client.end().catch(() => {});
  }
}
