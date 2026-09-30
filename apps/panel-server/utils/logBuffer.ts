import { currentServerId } from "./serverScope.ts";
type AnyRecord = Record<string, any>;

const buffers = new Map<string, AnyRecord[]>();
export function getLogBuffer(): AnyRecord[] {
  const id = currentServerId() ?? "panel";
  let buffer = buffers.get(id);
  if (!buffer) { buffer = []; buffers.set(id, buffer); }
  return buffer;
}

const MAX_BUFFER_SIZE = 500;

export function addLogToBuffer(
  level: unknown,
  message: unknown,
  source: unknown = "server",
): AnyRecord {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    source,
  };
  const logBuffer = getLogBuffer();
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER_SIZE) logBuffer.shift();
  return entry;
}
