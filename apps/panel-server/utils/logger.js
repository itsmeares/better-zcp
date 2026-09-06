import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { getDataPaths } from './paths.js';

// Get paths from central config
const paths = getDataPaths();
const logsDir = paths.logsDir;

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Store callbacks for log streaming
const logCallbacks = [];

export function onLog(callback) {
  logCallbacks.push(callback);
  return () => {
    const index = logCallbacks.indexOf(callback);
    if (index > -1) logCallbacks.splice(index, 1);
  };
}

// Custom transport to stream logs to callbacks
class CallbackTransport extends winston.Transport {
  log(info, callback) {
    setImmediate(() => {
      logCallbacks.forEach(cb => {
        try {
          cb({
            level: info.level,
            message: info.message,
            timestamp: info.timestamp || new Date().toISOString(),
            source: info.source || 'server'
          });
        } catch (e) {
          // Ignore callback errors
        }
      });
    });
    callback();
  }
}

// ── Level indicators ──
const levelIcons = {
  error: '✖',
  warn:  '⚠',
  info:  '●',
  debug: '·',
};

// ── Console format (compact, colored, human-friendly) ──
const consolePrintf = winston.format.printf(({ level, message, timestamp, stack, source }) => {
  const time = timestamp;                       // HH:mm:ss only
  const icon = levelIcons[level] || '•';
  const tag  = source ? `[${source}]` : '';
  const msg  = stack || message;
  // e.g.  12:34:56 ● [RCON] Connected on attempt 1
  return `${time} ${icon} ${tag}${tag ? ' ' : ''}${msg}`;
});

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  consolePrintf
);

// ── File format (full timestamp, structured, no colors) ──
const filePrintf = winston.format.printf(({ level, message, timestamp, stack, source }) => {
  const tag = source ? `[${source}] ` : '';
  return `${timestamp} [${level.toUpperCase()}] ${tag}${stack || message}`;
});

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  filePrintf
);

// Console transport with EPIPE protection — silences itself if the pipe breaks
// (e.g. terminal closed while the exe keeps running) to prevent an infinite
// error → log → error loop that floods the error log and can crash the process.
const consoleTransport = new winston.transports.Console({
  format: consoleFormat,
  handleExceptions: false
});
consoleTransport.on('error', (err) => {
  if (err && err.code === 'EPIPE') {
    consoleTransport.silent = true;
  }
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    consoleTransport,
    new winston.transports.File({ 
      filename: path.join(logsDir, 'error.log'), 
      level: 'error',
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB max file size
      maxFiles: 5,
      tailable: true
    }),
    new winston.transports.File({ 
      filename: path.join(logsDir, 'combined.log'),
      format: fileFormat,
      maxsize: 25 * 1024 * 1024, // 25MB max file size
      maxFiles: 3,
      tailable: true
    }),
    new CallbackTransport()
  ]
});

/**
 * Create a tagged child logger for a specific component.
 * Usage:  const log = createLogger('RCON');
 *         log.info('Connected');  → "12:34:56 ● [RCON] Connected"
 */
export function createLogger(source) {
  return logger.child({ source });
}

/**
 * Print a blank line to console (visual spacer).
 */
export function logBlank() {
  console.log('');
}

/**
 * Print a section header to console for grouping startup phases.
 * e.g.  ── Services ─────────────────────────────────────
 */
export function logSection(title) {
  const totalWidth = 50;
  const prefix = `── ${title} `;
  const line = '─'.repeat(Math.max(0, totalWidth - prefix.length));
  console.log(`\n  ${prefix}${line}`);
}

/**
 * Print a startup banner with app name and version.
 */
export function logBanner(version) {
  const title = 'Zomboid Control Panel';
  const ver = version ? `v${version}` : '';
  const content = ver ? `${title}  ${ver}` : title;
  const innerWidth = 49;
  const pad = Math.floor((innerWidth - content.length) / 2);
  const padded = ' '.repeat(pad) + content + ' '.repeat(innerWidth - pad - content.length);

  console.log('');
  console.log(`  ╔${'═'.repeat(innerWidth)}╗`);
  console.log(`  ║${padded}║`);
  console.log(`  ╚${'═'.repeat(innerWidth)}╝`);
}

/**
 * Print the "Ready" box with server URLs.
 * @param {{ label: string, url: string }[]} urls
 */
export function logReady(urls) {
  const lines = urls.map(u => `  ${u.label}   ${u.url}`);
  const maxLen = Math.max(...lines.map(l => l.length));
  const innerWidth = Math.max(maxLen + 2, 45);

  console.log('');
  console.log(`  ┌${'─'.repeat(innerWidth)}┐`);
  for (const line of lines) {
    const padded = line + ' '.repeat(innerWidth - line.length);
    console.log(`  │${padded}│`);
  }
  console.log(`  └${'─'.repeat(innerWidth)}┘`);
  console.log('');
}
