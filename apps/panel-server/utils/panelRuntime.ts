import { currentServerId } from "./serverScope.ts";

type Services = Record<string, any>;
let panel: Services | undefined;
const servers = new Map<string, Services>();

export function setPanelRuntime(services: Services): void {
  panel = services;
}
export function setServerRuntime(
  id: string | number,
  services: Services,
): void {
  servers.set(String(id), services);
}
export function removeServerRuntime(id: string | number): void {
  servers.delete(String(id));
}
export function getServerRuntimes(): Services[] {
  return [...servers.values()];
}
export function getPanelRuntime(): Services {
  if (!panel) throw new Error("Panel runtime is not initialized");
  const id = currentServerId();
  if (!id) return panel;
  const server = servers.get(id);
  if (!server) throw new Error(`Server runtime ${id} is not initialized`);
  return { ...panel, ...server };
}
