import winston from 'winston';
import TransportStream from 'winston-transport';
import path from 'path';
import fs from 'fs';
import { getDataPaths } from './paths.js';

const paths = getDataPaths();
const logsDir = paths.logsDir;

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

type LogEntry = {
  level: string;
  message: string;
  timestamp: string;
  source: string;
};

type LogCallback = (entry: LogEntry) => void;

type ReadyUrl = {
  label: string;
  url: string;
};

const logCallbacks: LogCallback[] = [];

export function onLog(callback: LogCallback) {
  logCallbacks.push(callback);
  return () => {
    const index = logCallbacks.indexOf(callback);
    if (index > -1) logCallbacks.splice(index, 1);
  };
}

class CallbackTransport extends TransportStream {
  log(info: winston.Logform.TransformableInfo, callback: () => void) {
    setImmediate(() => {
      logCallbacks.forEach(cb => {
        try {
          cb({
            level: info.level,
            message: String(info.message),
            timestamp: typeof info.timestamp === 'string' ? info.timestamp : new Date().toISOString(),
            source: typeof info.source === 'string' ? info.source : 'server',
          });
        } catch (e) {
          // Ignore callback errors
        }
      });
    });
    callback();
  }
}

const levelIcons: Record<string, string> = {
  error: '✖',
  warn:  '⚠',
  info:  '●',
  debug: '·',
};

const consolePrintf = winston.format.printf(({ level, message, timestamp, stack, source }) => {
  const time = String(timestamp ?? '');
  const icon = levelIcons[level] || '•';
  const tag  = source ? `[${String(source)}]` : '';
  const msg  = stack || message;
  return `${time} ${icon} ${tag}${tag ? ' ' : ''}${msg}`;
});

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  consolePrintf
);

const filePrintf = winston.format.printf(({ level, message, timestamp, stack, source }) => {
  const tag = source ? `[${String(source)}] ` : '';
  return `${String(timestamp ?? '')} [${level.toUpperCase()}] ${tag}${stack || message}`;
});

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  filePrintf
);

const consoleTransport = new winston.transports.Console({
  format: consoleFormat,
  handleExceptions: false
});
consoleTransport.on('error', (err: Error) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
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

export function createLogger(source: string) {
  return logger.child({ source });
}

export function logBlank() {
  console.log('');
}

export function logSection(title: string) {
  const totalWidth = 50;
  const prefix = `── ${title} `;
  const line = '─'.repeat(Math.max(0, totalWidth - prefix.length));
  console.log(`\n  ${prefix}${line}`);
}

export function logBanner(version?: string) {
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

export function logReady(urls: ReadyUrl[]) {
  const lines = urls.map((u) => `  ${u.label}   ${u.url}`);
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
