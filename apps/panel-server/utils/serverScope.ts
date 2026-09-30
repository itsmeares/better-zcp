import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<string>();

export function runForServer<T>(
  serverId: string | number,
  operation: () => T,
): T {
  const id = String(serverId);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid server ID");
  return scope.run(id, operation);
}

export function currentServerId(): string | undefined {
  return scope.getStore();
}

export function requireServerId(): string {
  const id = currentServerId();
  if (!id) throw new Error("This operation requires an explicit server ID");
  return id;
}
