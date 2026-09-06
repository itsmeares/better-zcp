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

let activeLock: LifecycleToken | null = null;
let nextLockId = 0;

export function acquireLifecycleLock(
  operation: unknown = "lifecycle",
  serverName: unknown = null,
): LifecycleLock | null {
  if (activeLock) return null;

  const token: LifecycleToken = {
    id: ++nextLockId,
    operation: String(operation || "lifecycle"),
    serverName:
      typeof serverName === "string" && serverName.trim()
        ? serverName.trim()
        : null,
  };
  activeLock = token;
  let released = false;

  return {
    operation: token.operation,
    release() {
      if (released) return;
      released = true;
      if (activeLock === token) activeLock = null;
    },
  };
}

export function lifecycleInProgressResponse(): {
  error: string;
  code: string;
} {
  const holder = activeLock;
  const error =
    holder?.operation && holder?.serverName
      ? `A '${holder.operation}' operation for '${holder.serverName}' is already in progress`
      : holder?.operation
        ? `A '${holder.operation}' operation is already in progress`
        : "Another server lifecycle operation is already in progress";
  return { error, code: LIFECYCLE_IN_PROGRESS_CODE };
}

export function isLifecycleLocked(): boolean {
  return activeLock !== null;
}
