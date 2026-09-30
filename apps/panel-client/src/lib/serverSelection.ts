import { router } from "../router";

export function getSelectedServerId(): string | null {
  if (typeof window === "undefined") return null;
  const value = router.state.location.search.server;
  return value && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

export async function selectServer(id: string | number | null): Promise<void> {
  await router.navigate({
    to: ".",
    search: (previous) => ({
      ...previous,
      server: id === null ? undefined : String(id),
    }),
  });
}

export function apiUrl(
  endpoint: string,
  serverId = getSelectedServerId(),
): string {
  if (
    /^\/server\/(install|quick-setup|steamcmd(?:\/|$)|branches$|network-interfaces$|list-directory$)/.test(
      endpoint,
    )
  )
    return `/api${endpoint}`;
  if (
    serverId &&
    /^\/(rcon|server|players|mods|server-files|debug|backup|map|config|docker|scheduler|system|panel-bridge)(\/|$)/.test(
      endpoint,
    )
  ) {
    return `/api/servers/${encodeURIComponent(serverId)}${endpoint}`;
  }
  return `/api${endpoint}`;
}
