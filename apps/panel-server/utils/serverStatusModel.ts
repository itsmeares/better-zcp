type ServerProvider = string;

interface ServerLike {
  provider?: string | null;
  dockerContainerId?: unknown;
  dockerContainerName?: unknown;
  isRemote?: boolean;
}

interface DockerContainer {
  handled?: boolean;
  error?: string | null;
  running?: boolean;
}

interface ServerSignalInput {
  connected?: boolean;
  connecting?: boolean;
  host?: string | null;
  port?: string | number | null;
}

interface BridgeSignalInput {
  configured?: boolean;
  running?: boolean;
  modConnected?: boolean;
}

interface Signal {
  status: string;
  label: string;
  detail: string | null;
}

const HOST_LABELS: Record<string, string> = {
  native: "Process",
  "docker-local": "Container",
  "docker-managed": "Container",
  "remote-sftp": "Host",
};

export function resolveProvider(
  server: ServerLike | null | undefined,
): ServerProvider {
  if (server?.provider) return server.provider;
  if (server?.dockerContainerId || server?.dockerContainerName) {
    return "docker-local";
  }
  return server?.isRemote ? "remote-sftp" : "native";
}

export function buildHostSignal(
  provider: ServerProvider,
  isRunning: boolean,
  scanFailed = false,
  dockerContainer: DockerContainer | null | undefined = null,
): Signal {
  if (provider === "native") {
    if (scanFailed) {
      return { status: "unknown", label: "Process", detail: "Process detection failed" };
    }
    return { status: isRunning ? "running" : "stopped", label: "Process", detail: null };
  }
  if (provider === "docker-local" || provider === "docker-managed") {
    if (!dockerContainer?.handled) {
      return {
        status: "unknown",
        label: "Container",
        detail: dockerContainer?.error || "Docker container status unavailable",
      };
    }
    if (dockerContainer.error) {
      return { status: "unknown", label: "Container", detail: dockerContainer.error };
    }
    return {
      status: dockerContainer.running ? "running" : "stopped",
      label: "Container",
      detail: null,
    };
  }
  if (provider === "remote-sftp") {
    return {
      status: "unknown",
      label: "Host",
      detail: "Cannot verify without SFTP access",
    };
  }
  return { status: "not-applicable", label: HOST_LABELS[provider] || "Host", detail: null };
}

export function buildServerSignal({
  connected,
  connecting,
  host,
  port,
}: ServerSignalInput = {}): Signal {
  const status = connected ? "connected" : connecting ? "connecting" : "disconnected";
  const detail = host && port ? `${host}:${port}` : null;
  return { status, label: "RCON", detail };
}

export function buildBridgeSignal({
  configured,
  running,
  modConnected,
}: BridgeSignalInput = {}): Signal {
  if (!configured) return { status: "not-installed", label: "PanelBridge", detail: null };
  const status = running && modConnected ? "active" : "offline";
  return { status, label: "PanelBridge", detail: null };
}

const HOST_WORDS: Record<string, string> = {
  running: "running",
  stopped: "stopped",
  unknown: "unknown",
  "not-applicable": "not applicable",
};
const SERVER_WORDS: Record<string, string> = {
  connected: "connected",
  disconnected: "disconnected",
  connecting: "connecting",
};

export function buildSummary(host: Signal, serverSignal: Signal): string {
  const hostWord = HOST_WORDS[host.status] || host.status;
  const serverWord = SERVER_WORDS[serverSignal.status] || serverSignal.status;
  return `${host.label} ${hostWord}, ${serverSignal.label} ${serverWord}`;
}

export function composeServerStatus({
  server,
  isRunning,
  scanFailed,
  rcon,
  bridge,
  dockerContainer,
}: {
  server?: ServerLike | null;
  isRunning?: boolean;
  scanFailed?: boolean;
  rcon?: ServerSignalInput;
  bridge?: BridgeSignalInput;
  dockerContainer?: DockerContainer | null;
} = {}) {
  const provider = resolveProvider(server);
  const host = buildHostSignal(provider, Boolean(isRunning), scanFailed, dockerContainer);
  const serverSignal = buildServerSignal(rcon);
  const bridgeSignal = buildBridgeSignal(bridge);
  return {
    provider,
    selected: true,
    host,
    server: serverSignal,
    bridge: bridgeSignal,
    summary: buildSummary(host, serverSignal),
  };
}
