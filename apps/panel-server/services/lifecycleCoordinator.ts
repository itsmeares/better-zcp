import { currentServerId } from "../utils/serverScope.ts";
export const LIFECYCLE_IN_PROGRESS_CODE = "SERVER_LIFECYCLE_IN_PROGRESS";

interface LifecycleToken {
  id: number;
  operation: string;
  serverName: string | null;
}

export interface LifecycleLock {
  operation: string;
  release: () => void;
}

const locks = new Map<string, LifecycleToken>();
let nextLockId = 0;

export function acquireLifecycleLock(
  operation: unknown = "lifecycle",
  serverName: unknown = null,
): LifecycleLock | null {
  const serverId = currentServerId() ?? "panel";
  if (locks.has(serverId)) return null;

  const token: LifecycleToken = {
    id: ++nextLockId,
    operation: String(operation || "lifecycle"),
    serverName:
      typeof serverName === "string" && serverName.trim()
        ? serverName.trim()
        : null,
  };
  locks.set(serverId, token);
  let released = false;

  return {
    operation: token.operation,
    release() {
      if (released) return;
      released = true;
      if (locks.get(serverId) === token) locks.delete(serverId);
    },
  };
}

export function lifecycleInProgressResponse(): {
  error: string;
  code: string;
} {
  const holder = locks.get(currentServerId() ?? "panel");
  const error =
    holder?.operation && holder?.serverName
      ? `A '${holder.operation}' operation for '${holder.serverName}' is already in progress`
      : holder?.operation
        ? `A '${holder.operation}' operation is already in progress`
        : "Another server lifecycle operation is already in progress";
  return { error, code: LIFECYCLE_IN_PROGRESS_CODE };
}

export function isLifecycleLocked(): boolean {
  return locks.has(currentServerId() ?? "panel");
}

export function isLifecycleLockedForServer(server: unknown): boolean {
  if (!server || typeof server !== "object") return false;
  return locks.has(String((server as { id?: unknown }).id));
}

export function getActiveLifecycleOperation(): string | null {
  return locks.get(currentServerId() ?? "panel")?.operation ?? null;
}
