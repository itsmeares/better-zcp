type AnyRecord = Record<string, any>;

export const logBuffer: AnyRecord[] = [];

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
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER_SIZE) logBuffer.shift();
  return entry;
}
