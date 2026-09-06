
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { logPlayerAction, recordPlayerSession } from '../database/init.js';
import { createLogger } from '../utils/logger.ts';
import { PanelBridgeSftpTransport } from './panelBridgeSftp.js';
const log = createLogger('Bridge');

const MOD_WRITE_SUFFIX = '.txt';
const RESULT_FILE_PATTERN = /^res-(\d+)\.json(?:\.txt)?$/;

const MIN_ORPHAN_TMP_AGE_MS = 60_000;

function isOldEnoughToSweep(filePath, minAgeMs = MIN_ORPHAN_TMP_AGE_MS) {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs >= minAgeMs;
  } catch (_) {
    return false;
  }
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

class PanelBridge extends EventEmitter {
  constructor() {
    super();
    this.bridgePath = null;
    this.isRunning = false;
    this.pollInterval = null;
    this.statusInterval = null;
    this.fileWatcher = null;
    this.sftpTransport = null;
    this.lastSftpStatus = null;
    this.pendingCommands = new Map();
    this.processedResults = new Map();
    this.protocolVersion = 'queue-v1';
    this.queue = {
      inboxDir: 'inbox',
      outboxDir: 'outbox',
      inboxCursorFile: path.join('inbox', 'cursor.json'),
      sequenceWidth: 10,
      maxResultsPerPoll: 100,
      retainRecentFiles: 200,
      cleanupIntervalMs: 60000,
      resyncStuckMs: 20000,
      resyncCheckIntervalMs: 5000
    };
    this.queueState = {
      initialized: false,
      nextCommandSeq: 1,
      lastConsumedResultSeq: 0
    };
    this.outboxStuckState = { seq: null, since: 0, nextCheckAt: 0 };
    this.inboxResyncNextCheckAt = 0;
    this.lastQueueCleanupAt = 0;
    this.modStatus = null;
    this.previousPlayers = new Set();
    this.lastStatusFileCheck = 0;
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 5;
    this.watcherRetries = 0;
    this.maxWatcherRetries = 3;
    this.config = {
      pollIntervalMs: 150,          // Fast polling for results (150ms)
      statusCheckMs: 1000,          // Check status every 1 second
      commandTimeoutMs: 15000,
      statusStaleMs: 45000,         // Status considered stale after 45 seconds (Lua updates every 3s)
      statusStaleIdleMs: 300000,    // 5 min tolerance when 0 players (PZ stops ticking with no players)
      fileWatchDebounceMs: 100
    };
  }

  configure(bridgeFolderPath, isDirectPath = false) {
    if (!bridgeFolderPath) {
      throw new Error('bridgeFolderPath is required');
    }

    if (isDirectPath) {
      this.bridgePath = bridgeFolderPath;
    } else {
      this.bridgePath = path.join(bridgeFolderPath, 'panelbridge');
    }


    log.debug(`Configured path: ${this.bridgePath}`);
    this.emit('configured', { path: this.bridgePath });

    return this.bridgePath;
  }

  async configureSftp(config, cachePath) {
    const transport = new PanelBridgeSftpTransport();
    try {
      await transport.start(config, cachePath);
    } catch (error) {
      this.lastSftpStatus = transport.getStatus();
      await transport.stop();
      this.lastSftpStatus = transport.getStatus();
      throw error;
    }

    const previousTransport = this.sftpTransport;
    try {
      if (this.isRunning) this.stop();
      if (previousTransport) await previousTransport.stop();
      this.configure(cachePath, true);
      this.config.commandTimeoutMs = 60000;
      this.sftpTransport = transport;
      this.lastSftpStatus = transport.getStatus();
      this.start();
    } catch (error) {
      this.sftpTransport = null;
      await transport.stop();
      this.lastSftpStatus = transport.getStatus();
      throw error;
    }
    return this.bridgePath;
  }

  async stopSftp() {
    if (this.sftpTransport) {
      await this.sftpTransport.stop();
      this.lastSftpStatus = this.sftpTransport.getStatus();
    }
    this.sftpTransport = null;
    this.config.commandTimeoutMs = 15000;
  }

  isSftpRunning() {
    return Boolean(this.sftpTransport?.running);
  }

  autoDetect(serverName, zomboidUserFolder = null) {
    if (!serverName || typeof serverName !== 'string' || !/^[a-zA-Z0-9_\- ]{1,64}$/.test(serverName)) {
      throw new Error('Invalid server name — use only letters, numbers, spaces, hyphens, and underscores (max 64 chars)');
    }

    const possibleBases = zomboidUserFolder
      ? [zomboidUserFolder]
      : process.platform === 'win32'
        ? [path.join(os.homedir(), 'Zomboid')]
        : [
            path.join(os.homedir(), 'Zomboid'),
            path.join(os.homedir(), 'pzserver'),
            '/opt/pz-server',
            '/srv/zomboid',
          ];

    for (const base of possibleBases) {
      const bridgePath = path.join(base, 'Lua', 'panelbridge', serverName);
      if (fs.existsSync(bridgePath)) {
        return this.configure(bridgePath, true);
      }
    }

    throw new Error(`Could not find panelbridge folder for server: ${serverName}`);
  }


  getModWriteFile(relativeName) {
    if (!this.bridgePath) return null;
    return path.join(this.bridgePath, `${relativeName}${MOD_WRITE_SUFFIX}`);
  }

  resolveModFile(relativeName) {
    if (!this.bridgePath) return null;
    const suffixedFile = this.getModWriteFile(relativeName);
    if (suffixedFile && fs.existsSync(suffixedFile)) return suffixedFile;
    return path.join(this.bridgePath, relativeName);
  }

  getCommandsFile() {
    return this.bridgePath ? path.join(this.bridgePath, 'commands.json') : null;
  }

  getResultsFile() {
    return this.resolveModFile('results.json');
  }

  getStatusFile() {
    return this.resolveModFile('status.json');
  }

  getInboxDir() {
    return this.bridgePath ? path.join(this.bridgePath, this.queue.inboxDir) : null;
  }

  getOutboxDir() {
    return this.bridgePath ? path.join(this.bridgePath, this.queue.outboxDir) : null;
  }

  getQueueStateFile() {
    return this.bridgePath ? path.join(this.bridgePath, '.queue-state-node.json') : null;
  }

  getInboxCursorFile() {
    return this.resolveModFile(this.queue.inboxCursorFile);
  }

  formatSeq(seq) {
    return String(seq).padStart(this.queue.sequenceWidth, '0');
  }

  getCommandFileBySeq(seq) {
    const inboxDir = this.getInboxDir();
    if (!inboxDir) return null;
    return path.join(inboxDir, `cmd-${this.formatSeq(seq)}.json`);
  }

  getResultFileBySeq(seq) {
    if (!this.bridgePath) return null;
    return this.resolveModFile(path.join(this.queue.outboxDir, `res-${this.formatSeq(seq)}.json`));
  }

  ensureQueueProtocol() {
    if (!this.bridgePath) {
      throw new Error('Bridge path not configured');
    }
    if (this.queueState.initialized) {
      return;
    }

    const inboxDir = this.getInboxDir();
    const outboxDir = this.getOutboxDir();
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });

    const stateFile = this.getQueueStateFile();
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8') || '{}');
        const nextSeq = Number(state.nextCommandSeq);
        const consumed = Number(state.lastConsumedResultSeq);
        this.queueState.nextCommandSeq = Number.isFinite(nextSeq) && nextSeq > 0 ? Math.floor(nextSeq) : 1;
        this.queueState.lastConsumedResultSeq = Number.isFinite(consumed) && consumed >= 0 ? Math.floor(consumed) : 0;
      } catch (error) {
        log.warn(`Could not parse queue state file: ${error.message}`);
        this.queueState.nextCommandSeq = 1;
        this.queueState.lastConsumedResultSeq = 0;
      }
    }

    const luaStateFile = this.resolveModFile('queue-state-lua.json');
    if (luaStateFile && fs.existsSync(luaStateFile)) {
      try {
        const luaState = JSON.parse(fs.readFileSync(luaStateFile, 'utf-8') || '{}');
        const lastCommandSeq = Number(luaState.lastCommandSeq);
        if (Number.isFinite(lastCommandSeq) && lastCommandSeq >= 0) {
          this.queueState.nextCommandSeq = Math.max(
            this.queueState.nextCommandSeq,
            Math.floor(lastCommandSeq) + 1,
          );
        }
      } catch (error) {
        log.warn(`Could not parse Lua queue state file: ${error.message}`);
      }
    }

    this.queueState.initialized = true;
    this.persistQueueState();
  }

  persistQueueState() {
    const stateFile = this.getQueueStateFile();
    if (!stateFile) return;
    const payload = {
      protocolVersion: this.protocolVersion,
      nextCommandSeq: this.queueState.nextCommandSeq,
      lastConsumedResultSeq: this.queueState.lastConsumedResultSeq,
      updatedAt: Date.now()
    };
    const tempFile = `${stateFile}.tmp`;
    try {
      fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
      fs.renameSync(tempFile, stateFile);
    } catch (error) {
      try {
        fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
      } catch (writeError) {
        log.warn(`Could not persist queue state: ${writeError.message}`);
      }
      try { fs.unlinkSync(tempFile); } catch (_) { /* ignore */ }
    }
  }

  getConnectionDiagnostics() {
    const bridgePath = this.bridgePath;
    const commandsFile = this.getCommandsFile();
    const resultsFile = this.getResultsFile();
    const statusFile = this.getStatusFile();

    const issues = [];
    const checks = {
      bridgePathConfigured: Boolean(bridgePath),
      bridgePathExists: false,
      bridgePathReadable: false,
      bridgePathWritable: false,
      inboxDirPresent: false,
      outboxDirPresent: false,
      commandsFilePresent: false,
      commandsFileReadable: false,
      resultsFilePresent: false,
      resultsFileReadable: false,
      statusFilePresent: false,
      statusFileReadable: false,
      statusFresh: false,
      statusAgeMs: null,
    };

    if (!bridgePath) {
      issues.push('Bridge path is not configured.');
      return {
        healthy: false,
        canSendCommands: false,
        checks,
        issues,
        summary: 'Bridge path not configured.',
      };
    }

    try {
      checks.bridgePathExists = fs.existsSync(bridgePath);
      if (!checks.bridgePathExists) {
        issues.push('Bridge directory does not exist yet.');
      }
    } catch (e) {
      issues.push(`Bridge directory check failed: ${e.message}`);
    }

    if (checks.bridgePathExists) {
      try {
        fs.accessSync(bridgePath, fs.constants.R_OK);
        checks.bridgePathReadable = true;
      } catch (e) {
        issues.push(`Bridge directory is not readable: ${e.message}`);
      }

      try {
        fs.accessSync(bridgePath, fs.constants.W_OK);
        checks.bridgePathWritable = true;
      } catch (e) {
        issues.push(`Bridge directory is not writable: ${e.message}`);
      }
    }

    const inspectFile = (filePath, presentKey, readableKey) => {
      if (!filePath) return;
      try {
        const exists = fs.existsSync(filePath);
        checks[presentKey] = exists;
        if (!exists) return;
        fs.accessSync(filePath, fs.constants.R_OK);
        checks[readableKey] = true;
      } catch (e) {
        checks[readableKey] = false;
        issues.push(`${path.basename(filePath)} is not readable: ${e.message}`);
      }
    };

    inspectFile(commandsFile, 'commandsFilePresent', 'commandsFileReadable');
    inspectFile(resultsFile, 'resultsFilePresent', 'resultsFileReadable');
    inspectFile(statusFile, 'statusFilePresent', 'statusFileReadable');

    const inboxDir = this.getInboxDir();
    const outboxDir = this.getOutboxDir();
    if (inboxDir) {
      checks.inboxDirPresent = fs.existsSync(inboxDir);
    }
    if (outboxDir) {
      checks.outboxDirPresent = fs.existsSync(outboxDir);
    }

    if (!checks.statusFilePresent) {
      issues.push('Status file is missing. Start the game server with PanelBridge enabled.');
    } else {
      try {
        const stats = fs.statSync(statusFile);
        const ageMs = Date.now() - stats.mtimeMs;
        const diagStaleMs = (this.modStatus?.playerCount === 0)
          ? this.config.statusStaleIdleMs
          : this.config.statusStaleMs;
        checks.statusAgeMs = ageMs;
        checks.statusFresh = ageMs < diagStaleMs;
        if (!checks.statusFresh) {
          issues.push(`Status file is stale (${formatAge(ageMs)} old) — is the PZ server running?`);
        }
      } catch (e) {
        issues.push(`Could not read status file metadata: ${e.message}`);
      }
    }

    const canSendCommands = checks.bridgePathConfigured
      && checks.bridgePathExists
      && checks.bridgePathWritable
      && checks.statusFilePresent
      && checks.statusFresh;

    return {
      healthy: issues.length === 0,
      canSendCommands,
      checks,
      issues,
      summary: issues[0] || 'Bridge file connection looks healthy.',
    };
  }

  start() {
    if (!this.bridgePath) {
      throw new Error('Bridge not configured. Call configure() first.');
    }

    if (this.isRunning) {
      log.debug('Already running');
      return;
    }

    this.consecutiveFailures = 0;
    this.lastStatusFileCheck = 0;
    this.queueState.initialized = false;
    this.ensureQueueProtocol();

    this.pollInterval = setInterval(() => this.pollResults(), this.config.pollIntervalMs);

    this.statusInterval = setInterval(() => this.checkModStatus(), this.config.statusCheckMs);

    this.setupFileWatcher();

    this.checkModStatus();

    this.isRunning = true;
    log.info(`Started - watching ${this.bridgePath}`);
    this.emit('started');
  }

  setupFileWatcher() {
    if (this.fileWatcher) {
      try {
        this.fileWatcher.close();
      } catch (e) {
        // Ignore close errors
      }
      this.fileWatcher = null;
    }

    if (this.watcherRetries >= this.maxWatcherRetries) {
        const hint = process.platform === 'linux'
          ? ' On Linux, check: sysctl fs.inotify.max_user_watches (increase to 524288 if low).'
          : '';
        log.warn(`Gave up on file watcher after ${this.maxWatcherRetries} attempts. Falling back to polling only.${hint}`);
        return;
    }

    try {
      this._debounceTimer = null;
      this.fileWatcher = fs.watch(this.bridgePath, { persistent: false }, (eventType, filename) => {
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
          this._debounceTimer = null;
          if (!this.isRunning) return;
          try {
            if (filename === 'status.json') {
              this.checkModStatus();
            } else if (filename === 'results.json') {
              this.pollResults();
            }
          } catch (e) {
            log.debug(`File change handler error: ${e.message}`);
          }
        }, this.config.fileWatchDebounceMs);
      });

      this.fileWatcher.on('error', (err) => {
        const hint = process.platform === 'linux' && (err.code === 'ENOSPC' || err.message.includes('inotify'))
          ? ' Increase fs.inotify.max_user_watches: sudo sysctl -w fs.inotify.max_user_watches=524288'
          : '';
        log.warn(`File watcher error: ${err.message}${hint}`);
        try {
          this.fileWatcher.close();
        } catch (e) { /* ignore */ }
        this.fileWatcher = null;
        this.watcherRetries++;

        setTimeout(() => {
          if (this.isRunning && !this.fileWatcher) {
            log.info(`Attempting to restart file watcher (attempt ${this.watcherRetries}/${this.maxWatcherRetries})...`);
            this.setupFileWatcher();
          }
        }, 5000);
      });

      log.debug('File watcher active');
      this.watcherRetries = 0;
    } catch (err) {
      this.watcherRetries++;
      log.warn(`Could not setup file watcher: ${err.message}`);

      if (this.watcherRetries < this.maxWatcherRetries) {
         setTimeout(() => {
             if (this.isRunning && !this.fileWatcher) {
                 this.setupFileWatcher();
             }
         }, 5000);
      }
    }
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    for (const [, pending] of this.pendingCommands) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Bridge stopped'));
    }
    this.pendingCommands.clear();

    this.processedResults.clear();
    this.trackPlayerActivity([]);
    this.watcherRetries = 0;
    this.modStatus = null;
    this.consecutiveFailures = 0;
    this.lastStatusFileCheck = 0;
    this.queueState.initialized = false;

    this.isRunning = false;
    log.info('Stopped');
    this.emit('stopped');
  }

  async sendCommand(action, args = {}) {
    log.debug(`sendCommand: action=${action} args=${JSON.stringify(args).substring(0, 200)}`);
    if (!this.bridgePath) {
      throw new Error('Bridge not configured');
    }
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }

    const connection = this.getConnectionDiagnostics();
    if (!connection.canSendCommands) {
      throw new Error(`Bridge file connection is unhealthy: ${connection.summary}`);
    }

    if (this.modStatus && !this.modStatus.alive && action !== 'ping') {
      throw new Error('Mod is not responding — check the PZ server is running with PanelBridge enabled');
    }

    const commandsFile = this.getCommandsFile();
    const id = uuidv4();
    this.ensureQueueProtocol();

    if (!this._writeQueue) this._writeQueue = Promise.resolve();

    let writeError = null;
    this._writeQueue = this._writeQueue
      .then(() => this._enqueueCommand(id, action, args))
      .catch(async (queueError) => {
        log.warn(`Queue write failed, falling back to legacy commands.json: ${queueError.message}`);
        await this._appendCommand(commandsFile, id, action, args);
      })
      .catch(err => { writeError = err; });
    await this._writeQueue;

    if (writeError) {
      throw new Error(`Failed to write command ${action}: ${writeError.message}`);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Command timeout: ${action} (no response from mod)`));
      }, this.config.commandTimeoutMs);

      this.pendingCommands.set(id, {
        resolve,
        reject,
        timeout,
        action,
        timestamp: Date.now()
      });
      log.debug(`sendCommand: queued action=${action} id=${id} (pending=${this.pendingCommands.size})`);
    });
  }

  _appendCommand(commandsFile, id, action, args) {
    let commands = { commands: [] };
    try {
      if (fs.existsSync(commandsFile)) {
        const content = fs.readFileSync(commandsFile, 'utf-8');
        if (content.trim()) {
          commands = JSON.parse(content);
          if (!commands.commands) commands.commands = [];
        }
      }
    } catch (e) {
      log.debug(`Failed to parse commands file ${commandsFile}: ${e.message}`);
      commands = { commands: [] };
    }

    commands.commands.push({
      id,
      action,
      args,
      timestamp: Date.now()
    });

    const tempFile = commandsFile + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(commands, null, 2), { mode: 0o600 });
    try {
      fs.renameSync(tempFile, commandsFile);
    } catch (err) {
      log.warn(`renameSync failed, using direct write: ${err.message}`);
      try {
        fs.writeFileSync(commandsFile, JSON.stringify(commands, null, 2), { mode: 0o600 });
      } catch (writeErr) {
        log.error(`Direct write also failed: ${writeErr.message}`);
        try { fs.unlinkSync(tempFile); } catch (_) { /* ignore */ }
        throw writeErr;
      }
      try { fs.unlinkSync(tempFile); } catch (_) { /* ignore */ }
    }
  }

  _enqueueCommand(id, action, args) {
    if (!this.queueState.initialized) {
      this.ensureQueueProtocol();
    }

    const seq = this.queueState.nextCommandSeq;
    const commandFile = this.getCommandFileBySeq(seq);
    const payload = {
      protocolVersion: this.protocolVersion,
      seq,
      id,
      action,
      args,
      createdAt: Date.now(),
      expiresAt: Date.now() + (this.config.commandTimeoutMs * 2)
    };

    const tempFile = `${commandFile}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tempFile, commandFile);

    this.queueState.nextCommandSeq = seq + 1;
    this.persistQueueState();
  }

  pollResults() {
    this.pollQueueResults();
    this.tryResyncInboxCommandCursor();
    this.pollLegacyResults();
    this.cleanupResultTracking();
    this.cleanupQueueFilesIfNeeded();
  }

  tryResyncOutboxCursor(seq) {
    const now = Date.now();
    if (this.outboxStuckState.seq !== seq) {
      this.outboxStuckState = { seq, since: now, nextCheckAt: now + this.queue.resyncStuckMs };
      return false;
    }
    if (now < this.outboxStuckState.nextCheckAt) {
      return false;
    }
    this.outboxStuckState.nextCheckAt = now + this.queue.resyncCheckIntervalMs;

    const luaStateFile = this.resolveModFile('queue-state-lua.json');
    if (!luaStateFile || !fs.existsSync(luaStateFile)) {
      return false;
    }

    let luaState;
    try {
      luaState = JSON.parse(fs.readFileSync(luaStateFile, 'utf-8') || '{}');
    } catch (error) {
      log.debug(`Could not parse mod queue state during resync check: ${error.message}`);
      return false;
    }

    const luaNextResultSeq = Number(luaState.nextResultSeq);
    if (!Number.isFinite(luaNextResultSeq) || luaNextResultSeq < 1) {
      return false;
    }

    const luaHighWater = luaNextResultSeq - 1;
    if (luaHighWater === this.queueState.lastConsumedResultSeq) {
      return false;
    }

    if (luaHighWater < this.queueState.lastConsumedResultSeq) {
      return false;
    }

    log.warn(`Outbox sequence desync detected, resyncing to mod position (expected seq ${seq}, mod high-water ${luaHighWater})`);
    this.recoverSkippedResults(this.queueState.lastConsumedResultSeq, luaHighWater);
    this.queueState.lastConsumedResultSeq = luaHighWater;
    this.persistQueueState();
    this.outboxStuckState.seq = null;
    return true;
  }

  recoverSkippedResults(fromSeqExclusive, toSeqInclusive) {
    const scanFrom = (toSeqInclusive - fromSeqExclusive) > this.queue.retainRecentFiles
      ? (toSeqInclusive - this.queue.retainRecentFiles + 1)
      : (fromSeqExclusive + 1);

    let recovered = 0;
    for (let seq = scanFrom; seq <= toSeqInclusive; seq++) {
      const resultFile = this.getResultFileBySeq(seq);
      if (!resultFile || !fs.existsSync(resultFile)) continue;

      let raw;
      try {
        raw = fs.readFileSync(resultFile, 'utf-8');
      } catch (error) {
        log.debug(`Resync recovery: could not read result seq ${seq}: ${error.message}`);
        continue;
      }
      if (!raw.trim()) continue;

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        log.debug(`Resync recovery: could not parse result seq ${seq}: ${error.message}`);
        continue;
      }

      const result = parsed && parsed.result ? parsed.result : parsed;
      if (result) {
        this.processResult(result);
        recovered++;
      }

      try {
        fs.writeFileSync(resultFile, '', { mode: 0o600 });
      } catch (cleanupErr) {
        log.debug(`Resync recovery: failed to clear result file seq ${seq}: ${cleanupErr.message}`);
      }
    }

    if (recovered > 0) {
      log.warn(`Resync recovery: recovered ${recovered} result(s) that the missing-file check would otherwise have skipped past`);
    }
  }

  tryResyncInboxCommandCursor() {
    const now = Date.now();
    if (now < this.inboxResyncNextCheckAt) {
      return false;
    }
    this.inboxResyncNextCheckAt = now + this.queue.resyncCheckIntervalMs;

    const luaStateFile = this.resolveModFile('queue-state-lua.json');
    if (!luaStateFile || !fs.existsSync(luaStateFile)) {
      return false;
    }

    let luaState;
    try {
      luaState = JSON.parse(fs.readFileSync(luaStateFile, 'utf-8') || '{}');
    } catch (error) {
      log.debug(`Could not parse mod queue state during inbox resync check: ${error.message}`);
      return false;
    }

    const luaLastCommandSeq = Number(luaState.lastCommandSeq);
    if (!Number.isFinite(luaLastCommandSeq) || luaLastCommandSeq < 0) {
      return false;
    }

    const luaNextExpected = luaLastCommandSeq + 1;
    if (luaNextExpected <= this.queueState.nextCommandSeq) {
      return false;
    }

    log.warn(`Command sequence desync detected: mod has processed through ${luaLastCommandSeq} but this process only expected to reach ${this.queueState.nextCommandSeq - 1}; advancing to avoid reusing already-consumed sequence numbers`);
    this.queueState.nextCommandSeq = luaNextExpected;
    this.persistQueueState();
    return true;
  }

  pollQueueResults() {
    if (!this.queueState.initialized) {
      try {
        this.ensureQueueProtocol();
      } catch (error) {
        log.debug(`Queue init not ready during poll: ${error.message}`);
        return;
      }
    }

    const maxToRead = this.queue.maxResultsPerPoll;
    let consumed = 0;
    while (consumed < maxToRead) {
      const seq = this.queueState.lastConsumedResultSeq + 1;
      const resultFile = this.getResultFileBySeq(seq);
      if (!resultFile || !fs.existsSync(resultFile)) {
        if (this.tryResyncOutboxCursor(seq)) {
          continue;
        }
        break;
      }

      let parsed = null;
      try {
        const raw = fs.readFileSync(resultFile, 'utf-8');
        if (!raw.trim()) {
          if (!this._emptyReadCounter) this._emptyReadCounter = { seq: 0, count: 0 };
          if (this._emptyReadCounter.seq !== seq) {
            this._emptyReadCounter.seq = seq;
            this._emptyReadCounter.count = 0;
          }
          this._emptyReadCounter.count++;
          if (this._emptyReadCounter.count >= 10) {
            log.warn(`Queue result seq ${seq} empty for ${this._emptyReadCounter.count} polls, advancing past it`);
            this.queueState.lastConsumedResultSeq = seq;
            this._emptyReadCounter.count = 0;
            consumed++;
            continue;
          }
          break;
        }
        if (this._emptyReadCounter) this._emptyReadCounter.count = 0;
        parsed = JSON.parse(raw);
      } catch (error) {
        log.debug(`Queue result parse error for seq ${seq}: ${error.message}`);
        break;
      }

      const result = parsed && parsed.result ? parsed.result : parsed;
      if (result) {
        this.processResult(result);
      }

      this.queueState.lastConsumedResultSeq = seq;
      consumed++;

      try {
        fs.writeFileSync(resultFile, '', { mode: 0o600 });
      } catch (cleanupErr) {
        log.debug(`Failed to clear result file seq ${seq}: ${cleanupErr.message}`);
      }
    }

    if (consumed > 0) {
      this.persistQueueState();
    }
  }

  pollLegacyResults() {
    const resultsFile = this.getResultsFile();
    if (!resultsFile || !fs.existsSync(resultsFile)) {
      return;
    }

    try {
      const content = fs.readFileSync(resultsFile, 'utf-8');
      if (!content.trim()) return;

      const data = JSON.parse(content);

      if (data.results && Array.isArray(data.results)) {
        for (const result of data.results) {
          this.processResult(result);
        }
      }

    } catch (e) {
      log.debug(`pollResults read error (likely mid-write): ${e.message}`);
    }
  }

  cleanupResultTracking() {
    if (this.processedResults.size > 500) {
      this.processedResults.clear();
    } else if (this.processedResults.size > 100) {
      let count = 0;
      for (const [key] of this.processedResults) {
        this.processedResults.delete(key);
        count++;
        if (count >= 50) break;
      }
    }

    const now = Date.now();
    const maxPendingAge = (this.config.commandTimeoutMs || 30000) * 2;
    for (const [id, cmd] of this.pendingCommands) {
      if (now - cmd.timestamp > maxPendingAge) {
        clearTimeout(cmd.timeout);
        this.pendingCommands.delete(id);
        log.warn(`Cleaned up stale pending command: ${cmd.action} (age: ${Math.round((now - cmd.timestamp) / 1000)}s)`);
      }
    }
  }

  cleanupQueueFilesIfNeeded() {
    const now = Date.now();
    if (now - this.lastQueueCleanupAt < this.queue.cleanupIntervalMs) {
      return;
    }
    this.lastQueueCleanupAt = now;

    try {
      this.cleanupInboxFiles();
    } catch (error) {
      log.debug(`Queue inbox cleanup skipped: ${error.message}`);
    }

    try {
      this.cleanupOutboxFiles();
    } catch (error) {
      log.debug(`Queue outbox cleanup skipped: ${error.message}`);
    }
  }

  cleanupInboxFiles() {
    const inboxDir = this.getInboxDir();
    if (!inboxDir || !fs.existsSync(inboxDir)) return;

    try {
      for (const fileName of fs.readdirSync(inboxDir)) {
        if (fileName.endsWith('.tmp')) {
          const tmpPath = path.join(inboxDir, fileName);
          if (!isOldEnoughToSweep(tmpPath)) continue;
          try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* ignore */ }

    const cursorFile = this.getInboxCursorFile();
    let lastProcessedSeq = 0;
    if (cursorFile && fs.existsSync(cursorFile)) {
      try {
        const cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf-8') || '{}');
        const parsed = Number(cursor.lastProcessedSeq);
        if (Number.isFinite(parsed) && parsed > 0) {
          lastProcessedSeq = Math.floor(parsed);
        }
      } catch (error) {
        log.debug(`Could not parse inbox cursor file: ${error.message}`);
      }
    }

    if (lastProcessedSeq <= this.queue.retainRecentFiles) {
      return;
    }

    const deleteUpToSeq = lastProcessedSeq - this.queue.retainRecentFiles;
    const files = fs.readdirSync(inboxDir);
    let deleted = 0;
    for (const fileName of files) {
      if (fileName.endsWith('.tmp')) {
        const tmpPath = path.join(inboxDir, fileName);
        if (isOldEnoughToSweep(tmpPath)) {
          try { fs.unlinkSync(tmpPath); deleted++; } catch (_) { /* ignore */ }
        }
        continue;
      }
      const seq = this.extractSeq(fileName, /^cmd-(\d+)\.json$/);
      if (seq !== null && seq <= deleteUpToSeq) {
        try {
          fs.unlinkSync(path.join(inboxDir, fileName));
          deleted++;
        } catch (_) {
          // Ignore cleanup failures.
        }
      }
    }

    if (deleted > 0) {
      log.debug(`Queue cleanup removed ${deleted} old inbox files (<= seq ${deleteUpToSeq})`);
    }
  }

  cleanupOutboxFiles() {
    const outboxDir = this.getOutboxDir();
    if (!outboxDir || !fs.existsSync(outboxDir)) return;

    try {
      for (const fileName of fs.readdirSync(outboxDir)) {
        if (fileName.endsWith('.tmp')) {
          const tmpPath = path.join(outboxDir, fileName);
          if (!isOldEnoughToSweep(tmpPath)) continue;
          try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* ignore */ }

    if (this.queueState.lastConsumedResultSeq <= this.queue.retainRecentFiles) {
      return;
    }

    const deleteUpToSeq = this.queueState.lastConsumedResultSeq - this.queue.retainRecentFiles;
    const files = fs.readdirSync(outboxDir);
    let deleted = 0;
    for (const fileName of files) {
      const seq = this.extractSeq(fileName, RESULT_FILE_PATTERN);
      if (seq !== null && seq <= deleteUpToSeq) {
        try {
          fs.unlinkSync(path.join(outboxDir, fileName));
          deleted++;
        } catch (_) {
          // Ignore cleanup failures.
        }
      }
    }

    if (deleted > 0) {
      log.debug(`Queue cleanup removed ${deleted} old outbox files (<= seq ${deleteUpToSeq})`);
    }
  }

  extractSeq(fileName, pattern) {
    const match = fileName.match(pattern);
    if (!match) return null;
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed)) return null;
    return Math.floor(parsed);
  }

  processResult(result) {
    if (!result || !result.id) return;

    if (this.processedResults.has(result.id)) return;
    this.processedResults.set(result.id, Date.now());

    const pending = this.pendingCommands.get(result.id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingCommands.delete(result.id);
      const elapsed = Date.now() - pending.timestamp;

      if (result.success) {
        log.debug(`PanelBridge result: action=${pending.action} success=true (${elapsed}ms)`);
        pending.resolve({ success: true, data: result.data });
      } else {
        const isChatFallback = pending.action === 'sendToServerChat' || pending.action === 'sendToAdminChat' || pending.action === 'sendToGeneralChat';
        const logLevel = isChatFallback ? 'debug' : 'warn';
        log[logLevel](`PanelBridge result: action=${pending.action} failed: ${result.error || 'unknown'} (${elapsed}ms)`);
        const message = result.error || result.data?.message || 'Command failed';
        const err = new Error(message);
        err.data = result.data;
        pending.reject(err);
      }
    }

    this.emit('result', result);
  }

  checkModStatus() {
    const statusFile = this.getStatusFile();

    if (!statusFile) {
      this.handleStatusFailure('No status file path configured');
      return;
    }

    if (!fs.existsSync(statusFile)) {
      this.handleStatusFailure('Status file does not exist');
      return;
    }

    try {
      const stats = fs.statSync(statusFile);
      const age = Date.now() - stats.mtimeMs;

      const staleThreshold = (this.modStatus?.playerCount === 0)
        ? this.config.statusStaleIdleMs
        : this.config.statusStaleMs;

      const hasValidStatus = this.modStatus && !this.modStatus.waiting && this.modStatus.version;
      if (stats.mtimeMs === this.lastStatusFileCheck && hasValidStatus) {
        if (this.modStatus.age !== age) {
          this.modStatus.age = age;
          this.modStatus.alive = age < staleThreshold;
          if (!this.modStatus.alive && this.modStatus._wasAlive) {
            this.modStatus._wasAlive = false;
            this.emit('modStatus', this.modStatus);
          }
        }
        return;
      }

      const content = fs.readFileSync(statusFile, 'utf-8');
      if (!content.trim()) {
        this.handleStatusFailure('Status file is empty');
        return;
      }

      const status = JSON.parse(content);

      this.lastStatusFileCheck = stats.mtimeMs;
      this.consecutiveFailures = 0;

      const fullReadStaleThreshold = (status.playerCount === 0)
        ? this.config.statusStaleIdleMs
        : this.config.statusStaleMs;
      status.alive = age < fullReadStaleThreshold;
      status.age = age;
      status._wasAlive = status.alive;
      status.filePath = statusFile;

      if (status.alive && status.players) {
        this.trackPlayerActivity(status.players);
      }

      const aliveChanged = this.modStatus?.alive !== status.alive;
      const isNewStatus = !this.modStatus;
      const dataChanged = JSON.stringify(status) !== JSON.stringify(this.modStatus);

      if (aliveChanged || isNewStatus || dataChanged) {
        this.modStatus = status;
        this.emit('modStatus', status);

        if (status.alive && (aliveChanged || isNewStatus)) {
          log.info(`Mod connected (age: ${Math.round(age / 1000)}s, players: ${status.playerCount})`);
        }
      }
    } catch (e) {
      this.handleStatusFailure(`Parse error: ${e.message}`);
    }
  }

  handleStatusFailure(reason) {
    this.consecutiveFailures++;

    if (this.consecutiveFailures === 1 || this.consecutiveFailures % 10 === 0) {
      log.debug(`Status check failed (${this.consecutiveFailures}x): ${reason}`);
    }

    if (this.modStatus?.alive && this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.trackPlayerActivity([]);
      this.modStatus = {
        ...this.modStatus,
        alive: false,
        error: reason,
        consecutiveFailures: this.consecutiveFailures,
        lastPath: this.bridgePath,
        playerCount: undefined,
        players: []
      };
      this.emit('modStatus', this.modStatus);
      log.warn(`Mod marked as disconnected after ${this.consecutiveFailures} failures`);
    } else if (!this.modStatus) {
      this.modStatus = { alive: false, waiting: true, version: null, playerCount: undefined, players: [] };
    }
  }

  trackPlayerActivity(currentPlayers) {
    const playerList = Array.isArray(currentPlayers) ? currentPlayers : Object.keys(currentPlayers || {});
    const current = new Set(playerList);
    const previous = this.previousPlayers;

    for (const player of current) {
      if (!previous.has(player)) {
        logPlayerAction(player, 'connect', 'Player connected to server').catch(err => log.debug(`Failed to log player connect: ${err.message}`));
        recordPlayerSession(player, 'connect').catch(err => log.debug(`Failed to record player connect session: ${err.message}`));
        this.emit('playerConnect', player);
      }
    }

    for (const player of previous) {
      if (!current.has(player)) {
        logPlayerAction(player, 'disconnect', 'Player disconnected from server').catch(err => log.debug(`Failed to log player disconnect: ${err.message}`));
        recordPlayerSession(player, 'disconnect').catch(err => log.debug(`Failed to record player disconnect session: ${err.message}`));
        this.emit('playerDisconnect', player);
      }
    }

    this.previousPlayers = current;
  }

  getStatus() {
    const statusFile = this.getStatusFile();
    let fileInfo = null;

    if (statusFile) {
      try {
        if (fs.existsSync(statusFile)) {
          const stats = fs.statSync(statusFile);
          fileInfo = {
            exists: true,
            path: statusFile,
            size: stats.size,
            modified: stats.mtime,
            age: Date.now() - stats.mtimeMs,
            ageSeconds: Math.round((Date.now() - stats.mtimeMs) / 1000)
          };
        } else {
          fileInfo = { exists: false, path: statusFile };
        }
      } catch (e) {
        fileInfo = { exists: false, error: e.message };
      }
    }

    return {
      configured: !!this.bridgePath,
      bridgePath: this.bridgePath,
      isRunning: this.isRunning,
      pendingCommands: this.pendingCommands.size,
      modStatus: this.modStatus,
      connection: this.getConnectionDiagnostics(),
      consecutiveFailures: this.consecutiveFailures,
      config: {
        statusStaleMs: this.config.statusStaleMs,
        pollIntervalMs: this.config.pollIntervalMs,
        statusCheckMs: this.config.statusCheckMs
      },
      statusFile: fileInfo,
      hasFileWatcher: !!this.fileWatcher,
      transport: this.sftpTransport?.getStatus() || { type: 'local', running: this.isRunning },
      lastSftpTransport: this.lastSftpStatus
    };
  }

  isModConnected() {
    return this.modStatus?.alive === true;
  }

  async ping() {
    if (!this.isRunning) {
      return { success: false, error: 'Bridge not running' };
    }
    if (!this.isModConnected()) {
      return { success: false, error: 'Mod not connected', modStatus: this.modStatus };
    }
    try {
      const result = await this.sendCommand('ping', {});
      return { ...result, modStatus: this.modStatus };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getWeather() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getWeather', {});
  }

  async getServerInfo() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getServerInfo', {});
  }

  async triggerBlizzard(duration = 1.0) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('triggerBlizzard', { duration });
  }

  async triggerTropicalStorm(duration = 1.0) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('triggerTropicalStorm', { duration });
  }

  async triggerStorm(duration = 1.0) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('triggerStorm', { duration });
  }

  async stopWeather() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('stopWeather', {});
  }

  async setSnow(enabled = true, intensity = null) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    const args = { enabled };
    if (intensity !== null) args.intensity = intensity;
    return this.sendCommand('setSnow', args);
  }


  async startRain(intensity = 0.5) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('startRain', { intensity });
  }

  async stopRain() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('stopRain', {});
  }

  async triggerLightning(x = null, y = null, strike = true, light = true, rumble = true) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('triggerLightning', { x, y, strike, light, rumble });
  }

  async setClimateFloat(floatId, value, enable = true) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('setClimateFloat', { floatId, value, enable });
  }

  async getClimateFloats() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getClimateFloats', {});
  }

  async resetClimateOverrides() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('resetClimateOverrides', {});
  }

  async getGameTime() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getGameTime', {});
  }

  async setGameTime(options = {}) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('setGameTime', options);
  }

  async getWorldStats() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getWorldStats', {});
  }

  async getPlayerDetails(username) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getPlayerDetails', { username });
  }

  async getAllPlayerDetails() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getAllPlayerDetails', {});
  }

  async teleportPlayer(username, x, y, z = 0) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('teleportPlayer', { username, x, y, z });
  }

  async getSandboxOptions() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('getSandboxOptions', {});
  }

  async saveWorld() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('saveWorld', {});
  }


  async playWorldSound(x, y, z = 0, radius = 50, volume = 100) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('playWorldSound', { x, y, z, radius, volume });
  }

  async playSoundNearPlayer(username, radius = 50, volume = 100) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('playSoundNearPlayer', { username, radius, volume });
  }

  async triggerGunshot(options = {}) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('triggerGunshot', options);
  }

  async triggerAlarmSound(options = {}) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('triggerAlarmSound', options);
  }

  async createNoise(options = {}) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('createNoise', options);
  }


  async generateWeather(strength = 0.5, frontType = 0) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('generateWeather', { strength, frontType });
  }

  async setTemperature(value = 22) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('setTemperature', { value });
  }

  async setWind(value = 0.5) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('setWind', { value });
  }

  async setFog(value = 0) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('setFog', { value });
  }

  async setClouds(value = 0) {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('setClouds', { value });
  }

  async clearErrors() {
    if (!this.isRunning) {
      throw new Error('Bridge not running');
    }
    return this.sendCommand('clearErrors', {});
  }
}

const bridge = new PanelBridge();

export { PanelBridge, bridge };
export default bridge;
