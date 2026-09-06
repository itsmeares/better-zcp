export const LIFECYCLE_IN_PROGRESS_CODE = "SERVER_LIFECYCLE_IN_PROGRESS";

let activeLock = null;
let nextLockId = 0;

// 2026-09-04, lifecycle-lock investigation: the lock itself was never the
// problem -- every acquire/release path was already correct, and the
// process-wide scope is intentional (an auto-update must not run while
// someone clicks Start on any server; a per-server lock would not prevent
// that). The actual defect was the REFUSAL MESSAGE: "Another server
// lifecycle operation is already in progress" names neither the operation
// nor the server holding the lock, so even an engineer who had just
// instrumented this exact code path read a correct 409 as a probable leak.
// `serverName` is optional and purely cosmetic for the 409 message below --
// it changes nothing about who holds the lock or how it's released.
export function acquireLifecycleLock(operation = "lifecycle", serverName = null) {
  if (activeLock) return null;

  const token = {
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

// Reads the CURRENT holder off `activeLock` directly rather than taking a
// descriptor argument, so every call site at every refusal point (13 of
// them) needs no change at all -- only acquireLifecycleLock() callers gained
// an optional second argument. Degrades to the original generic wording
// when the holder didn't pass a name (boot auto-start, automatic updates --
// operations with no single server to name), rather than rendering
// something like "for 'undefined'".
export function lifecycleInProgressResponse() {
  const holder = activeLock;
  const error =
    holder?.operation && holder?.serverName
      ? `A '${holder.operation}' operation for '${holder.serverName}' is already in progress`
      : holder?.operation
        ? `A '${holder.operation}' operation is already in progress`
        : "Another server lifecycle operation is already in progress";
  return { error, code: LIFECYCLE_IN_PROGRESS_CODE };
}

export function isLifecycleLocked() {
  return activeLock !== null;
}
