import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';
const log = createLogger('LogTailer');
import { getActiveServer, getSetting } from '../database/init.js';

const SHOUT_CHAT_ROOM_ID = 2;

const DELIVERY_LINE = /Message ChatMessage\{chat=([^,]+),\s*author='(.*?)',\s*text='(.*)'\} sent to chat \(id = (\d+)\)/;

export function chatMessageKey(chatType, author, text) {
  return `${chatType}\u0000${author}\u0000${text}`;
}

export function collectChatRoomIds(lines) {
  const ids = new Map();
  for (const line of lines) {
    const m = line.match(DELIVERY_LINE);
    if (!m) continue;
    const key = chatMessageKey(m[1].trim(), m[2], m[3]);
    const bucket = ids.get(key);
    if (bucket) bucket.push(Number(m[4]));
    else ids.set(key, [Number(m[4])]);
  }
  return ids;
}

export class LogTailer extends EventEmitter {
  constructor() {
    super();
    this.logPath = null;
    this.chatLogPath = null;
    this.chatLogSize = 0;
    this.currentSize = 0;
    this.userLogPath = null;
    this.userLogSize = 0;
    this.isWatching = false;
    this.checkTimer = null;
    this.logsDir = null;
    this.basePath = null;
    this.watchStartedAt = Date.now();
    this.consoleRemainder = '';
    this.chatRemainder = '';
    this.userRemainder = '';
  }

  startOffsetFor(filePath, firstDiscovery) {
    try {
        const stats = fs.statSync(filePath);
        const born = stats.birthtimeMs || 0;
        if (!firstDiscovery || (born > 0 && born >= this.watchStartedAt)) return 0;
        return stats.size;
    } catch (e) {
        log.debug(`LogTailer: stat failed for ${filePath}: ${e.message}`);
        return 0;
    }
  }

  async init() {
    await this.findLogPath();
    this.startWatching();
  }

  async findLogPath() {
    try {
        const activeServer = await getActiveServer();
        const homeDir = os.homedir();
        let basePath = process.env.PZ_SAVE_PATH || (homeDir ? path.join(homeDir, 'Zomboid') : '');

        if (activeServer?.zomboidDataPath) {
            basePath = activeServer.zomboidDataPath;
        } else {
            const settingPath = await getSetting('zomboidDataPath');
            if (settingPath) basePath = settingPath;
        }
        this.basePath = basePath;

        const consoleLogPath = path.join(basePath, 'server-console.txt');
        if (fs.existsSync(consoleLogPath)) {
            try {
                fs.accessSync(consoleLogPath, fs.constants.R_OK);
                this.logPath = consoleLogPath;
                log.info(`Found console log at ${consoleLogPath}`);
            } catch (e) {
                log.warn(`Console log exists but is not readable (check permissions): ${consoleLogPath}`);
            }
        } else {
            log.warn(`Could not find server-console.txt at ${consoleLogPath}`);
        }

        const logsDir = path.join(basePath, 'Logs');
        if (fs.existsSync(logsDir)) {
            this.logsDir = logsDir;
            this.findLatestChatLog();
            this.findLatestUserLog();
        }

    } catch (e) {
        log.error(`Error finding log path: ${e.stack || e.message}`);
    }
  }

  reresolvePaths() {
    if (!this.basePath) return;
    if (!this.logPath) {
        const consoleLogPath = path.join(this.basePath, 'server-console.txt');
        try {
            fs.accessSync(consoleLogPath, fs.constants.R_OK);
            this.logPath = consoleLogPath;
            this.currentSize = this.startOffsetFor(consoleLogPath, true);
            log.info(`Found console log at ${consoleLogPath}`);
        } catch {
            /* not there yet */
        }
    }
    if (!this.logsDir) {
        const logsDir = path.join(this.basePath, 'Logs');
        if (fs.existsSync(logsDir)) {
            this.logsDir = logsDir;
            log.info(`Found Logs directory at ${logsDir}`);
        }
    }
  }

  findLatestChatLog() {
    if (!this.logsDir) return;
    try {
        const files = fs.readdirSync(this.logsDir)
            .filter(f => f.endsWith('_chat.txt'))
            .map(f => {
                const full = path.join(this.logsDir, f);
                try {
                    const stats = fs.statSync(full);
                    return { path: full, mtime: stats.mtimeMs, birthtime: stats.birthtimeMs };
                }
                catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => (b.mtime - a.mtime) || (b.birthtime - a.birthtime));

        if (files.length > 0) {
            const latest = files[0].path;
            if (latest !== this.chatLogPath) {
                const firstDiscovery = !this.chatLogPath;
                this.chatLogPath = latest;
                this.chatRemainder = '';
                this.chatLogSize = this.startOffsetFor(latest, firstDiscovery);
                log.info(`Tailing B42 chat log: ${latest}`);
            }
        }
    } catch (e) {
        log.debug(`Error scanning chat logs: ${e.message}`);
    }
  }

  findLatestUserLog() {
    if (!this.logsDir) return;
    try {
        const files = fs.readdirSync(this.logsDir)
            .filter(f => f.endsWith('_user.txt'))
            .map(f => {
                const full = path.join(this.logsDir, f);
                try {
                    const stats = fs.statSync(full);
                    return { path: full, mtime: stats.mtimeMs, birthtime: stats.birthtimeMs };
                }
                catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => (b.mtime - a.mtime) || (b.birthtime - a.birthtime));

        if (files.length > 0) {
            const latest = files[0].path;
            if (latest !== this.userLogPath) {
                const firstDiscovery = !this.userLogPath;
                this.userLogPath = latest;
                this.userRemainder = '';
                this.userLogSize = this.startOffsetFor(latest, firstDiscovery);
                log.info(`Tailing B42 user log: ${latest}`);
            }
        }
    } catch (e) {
        log.debug(`Error scanning user logs: ${e.message}`);
    }
  }

  async startWatching() {
    if (this.isWatching) return;

    try {
        if (this.logPath && fs.existsSync(this.logPath)) {
            const stats = fs.statSync(this.logPath);
            this.currentSize = stats.size;
        }

        log.info(`Started watching (console: ${this.logPath || 'none'}, chatLog: ${this.chatLogPath || 'none'}, userLog: ${this.userLogPath || 'none'})`);

        this.isWatching = true;
        this.checkLoop();
    } catch (e) {
        log.error(`Failed to start watching: ${e.message}`);
        this.isWatching = false;
    }
  }

  stopWatching() {
     log.info('LogTailer stopping...');
     if (this.checkTimer) {
         clearTimeout(this.checkTimer);
         this.checkTimer = null;
     }
     this.isWatching = false;
  }

  async checkLoop() {
      if (!this.isWatching) return;

      this.reresolvePaths();
      await this.checkConsoleLog();
      await this.checkChatLog();
      await this.checkUserLog();

      if (this.isWatching) {
          this.checkTimer = setTimeout(() => this.checkLoop(), 2000);
      }
  }

  async checkConsoleLog() {
     if (!this.logPath) return;
     try {
         let stats;
         try { stats = await fs.promises.stat(this.logPath); } catch (e) {
           log.debug(`LogTailer: console log stat failed: ${e.message}`);
           return;
         }

         if (stats.size > this.currentSize) {
             const bytesToRead = stats.size - this.currentSize;
             if (bytesToRead > 1024 * 1024) {
                 log.warn(`Console log grew by ${Math.round(bytesToRead / 1024)}KB since the last poll — skipping the burst`);
                 this.currentSize = stats.size;
                 this.consoleRemainder = '';
                 return;
             }
             const data = await this.readChunk(this.logPath, this.currentSize, stats.size);
             this.currentSize = stats.size;
             if (data) this.processConsoleData(data);
         } else if (stats.size < this.currentSize) {
             this.currentSize = 0;
             this.consoleRemainder = '';
         }
     } catch (e) {
       log.debug(`LogTailer: console log polling error: ${e.message}`);
     }
  }

  async checkChatLog() {
     if (this.logsDir) {
       const prevChatLog = this.chatLogPath;
       this.findLatestChatLog();
       if (this.chatLogPath && this.chatLogPath !== prevChatLog) {
         log.info(`LogTailer: new chat log discovered: ${this.chatLogPath}`);
       }
     }
     if (!this.chatLogPath) return;

     try {
         let stats;
         try { stats = await fs.promises.stat(this.chatLogPath); } catch (e) {
           log.debug(`LogTailer: chat log stat failed: ${e.message}`);
           return;
         }

         if (stats.size > this.chatLogSize) {
             const bytesToRead = stats.size - this.chatLogSize;
             if (bytesToRead > 1024 * 1024) {
                 log.warn(`Chat log grew by ${Math.round(bytesToRead / 1024)}KB since the last poll — skipping the burst, those messages will not reach Discord`);
                 this.chatLogSize = stats.size;
                 this.chatRemainder = '';
                 return;
             }
             const data = await this.readChunk(this.chatLogPath, this.chatLogSize, stats.size);
             this.chatLogSize = stats.size;
             if (data) this.processChatLogData(data);
         } else if (stats.size < this.chatLogSize) {
             this.chatLogSize = 0;
             this.chatRemainder = '';
         }
     } catch (e) {
       log.debug(`LogTailer: chat log polling error: ${e.message}`);
     }
  }

  readChunk(filePath, start, end) {
    return new Promise((resolve) => {
        if (end <= start) return resolve(null);
        const stream = fs.createReadStream(filePath, { start, end: end - 1 });
        let data = '';
        stream.on('data', chunk => data += chunk);
        stream.on('end', () => resolve(data));
        stream.on('error', () => resolve(null));
    });
  }

  _splitLines(data, remainderKey) {
    const lines = (this[remainderKey] + data).split(/\r?\n/);
    let remainder = lines.pop() ?? '';
    if (remainder.length > 64 * 1024) remainder = '';
    this[remainderKey] = remainder;
    return lines;
  }

  processConsoleData(data) {
    const lines = this._splitLines(data, 'consoleRemainder');
    for (const line of lines) {
        if (!line.trim()) continue;
        if (line.includes('[chat]')) {
            const cleanLine = line.replace(/^\[.*?\]\s*/, '');
            if (!cleanLine.includes('[chat]')) continue;
            const match = cleanLine.match(/<([^>]+)>\s+(.*)/);
            if (match) {
                this.emit('chatMessage', {
                    author: match[1],
                    message: match[2],
                    type: 'general',
                    timestamp: new Date()
                });
            }
        }
    }
  }

  processChatLogData(data) {
    const lines = this._splitLines(data, 'chatRemainder');
    const chatIds = collectChatRoomIds(lines);
    for (const line of lines) {
        if (!line.trim()) continue;

        const msgMatch = line.match(/Got message:ChatMessage\{chat=([^,]+),\s*author='(.*?)',\s*text='(.*)'\}/);
        if (msgMatch) {
            const chatType = msgMatch[1].trim();
            const author = msgMatch[2];
            const text = msgMatch[3];
            const roomIds = chatIds.get(chatMessageKey(chatType, author, text));
            const roomId = roomIds && roomIds.length ? roomIds.shift() : null;
            const sourceChatType =
                chatType === 'Local' && roomId === SHOUT_CHAT_ROOM_ID
                    ? 'Shout'
                    : chatType;
            let type = 'general';
            if (chatType === 'Admin chat') type = 'admin';
            else if (chatType === 'Server Alert' || chatType === 'Server chat') type = 'server';
            else if (chatType === 'Local') type = 'general';
            else if (chatType === 'Shout') type = 'general';

            this.emit('chatMessage', {
                author,
                message: text,
                type,
                sourceChatType,
                timestamp: new Date()
            });
            continue;
        }

        const alertMatch = line.match(/Server alert message: '(.+)' sent\.\./);
        if (alertMatch) {
            this.emit('chatMessage', {
                author: 'Server',
                message: alertMatch[1],
                type: 'server',
                timestamp: new Date()
            });
        }
    }
  }

  async checkUserLog() {
     if (this.logsDir) {
       const prev = this.userLogPath;
       this.findLatestUserLog();
       if (this.userLogPath && this.userLogPath !== prev) {
         log.info(`LogTailer: new user log discovered: ${this.userLogPath}`);
       }
     }
     if (!this.userLogPath) return;

     try {
         let stats;
         try { stats = await fs.promises.stat(this.userLogPath); } catch (e) {
           log.debug(`LogTailer: user log stat failed: ${e.message}`);
           return;
         }

         if (stats.size > this.userLogSize) {
             const bytesToRead = stats.size - this.userLogSize;
             if (bytesToRead > 1024 * 1024) {
                 log.warn(`User log grew by ${Math.round(bytesToRead / 1024)}KB since the last poll — skipping the burst`);
                 this.userLogSize = stats.size;
                 this.userRemainder = '';
                 return;
             }
             const data = await this.readChunk(this.userLogPath, this.userLogSize, stats.size);
             this.userLogSize = stats.size;
             if (data) this.processUserLogData(data);
         } else if (stats.size < this.userLogSize) {
             this.userLogSize = 0;
             this.userRemainder = '';
         }
     } catch (e) {
       log.debug(`LogTailer: user log polling error: ${e.message}`);
     }
  }

  processUserLogData(data) {
    const lines = this._splitLines(data, 'userRemainder');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const deathMatch = trimmed.match(/user\s+(.+?)\s+died at\s+\((-?\d+),(-?\d+),(-?\d+)\)\s*(?:\((non\s*pvp|pvp)\))?/i);
        if (deathMatch) {
            const player = deathMatch[1];
            const x = parseInt(deathMatch[2], 10);
            const y = parseInt(deathMatch[3], 10);
            const z = parseInt(deathMatch[4], 10);
            const pvp = (deathMatch[5] || '').toLowerCase() === 'pvp';
            this.emit('playerDeath', {
                player,
                x, y, z,
                pvp,
                location: `${x},${y},${z}`,
                timestamp: new Date(),
            });
        }
    }
  }
}
