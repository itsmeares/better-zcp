
const HOST_LABELS = {
  native: "Process",
  "docker-local": "Container",
  "docker-managed": "Container",
  "remote-sftp": "Host",
};

export function resolveProvider(server) {
  if (server?.provider) return server.provider;
  if (server?.dockerContainerId || server?.dockerContainerName) {
    return "docker-local";
  }
  return server?.isRemote ? "remote-sftp" : "native";
}

export function buildHostSignal(provider, isRunning, scanFailed = false, dockerContainer = null) {
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

export function buildServerSignal({ connected, connecting, host, port } = {}) {
  const status = connected ? "connected" : connecting ? "connecting" : "disconnected";
  const detail = host && port ? `${host}:${port}` : null;
  return { status, label: "RCON", detail };
}

export function buildBridgeSignal({ configured, running, modConnected } = {}) {
  if (!configured) return { status: "not-installed", label: "PanelBridge", detail: null };
  const status = running && modConnected ? "active" : "offline";
  return { status, label: "PanelBridge", detail: null };
}

const HOST_WORDS = {
  running: "running",
  stopped: "stopped",
  unknown: "unknown",
  "not-applicable": "not applicable",
};
const SERVER_WORDS = { connected: "connected", disconnected: "disconnected", connecting: "connecting" };

export function buildSummary(host, serverSignal) {
  const hostWord = HOST_WORDS[host.status] || host.status;
  const serverWord = SERVER_WORDS[serverSignal.status] || serverSignal.status;
  return `${host.label} ${hostWord}, ${serverSignal.label} ${serverWord}`;
}

export function composeServerStatus({ server, isRunning, scanFailed, rcon, bridge, dockerContainer }) {
  const provider = resolveProvider(server);
  const host = buildHostSignal(provider, isRunning, scanFailed, dockerContainer);
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
