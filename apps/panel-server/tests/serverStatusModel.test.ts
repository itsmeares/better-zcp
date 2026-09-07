import { describe, expect, it } from "vitest";
import {
  resolveProvider,
  buildHostSignal,
  buildServerSignal,
  buildBridgeSignal,
  buildSummary,
  composeServerStatus,
} from "../utils/serverStatusModel.ts";

describe("resolveProvider", () => {
  it("defaults a local server to native", () => {
    expect(resolveProvider({ isRemote: false })).toBe("native");
  });

  it("maps isRemote to remote-sftp", () => {
    expect(resolveProvider({ isRemote: true })).toBe("remote-sftp");
  });

  it("honours an explicit provider field over isRemote", () => {
    expect(resolveProvider({ isRemote: true, provider: "docker-local" })).toBe(
      "docker-local",
    );
  });

  it("infers docker-local from legacy container fields", () => {
    expect(resolveProvider({ dockerContainerName: "pz-server" })).toBe(
      "docker-local",
    );
  });
});

describe("buildHostSignal", () => {
  it("reports native process state directly", () => {
    expect(buildHostSignal("native", true)).toEqual({
      status: "running",
      label: "Process",
      detail: null,
    });
    expect(buildHostSignal("native", false)).toEqual({
      status: "stopped",
      label: "Process",
      detail: null,
    });
  });

  it("reports remote-sftp hosts as unknown — no way to verify without SFTP", () => {
    const signal = buildHostSignal("remote-sftp", true);
    expect(signal.status).toBe("unknown");
    expect(signal.label).toBe("Host");
  });

  it("reports Docker container state from the managed-container lookup, ignoring the local scan", () => {
    expect(
      buildHostSignal("docker-local", true, false, { handled: true, running: true }),
    ).toEqual({ status: "running", label: "Container", detail: null });

    expect(
      buildHostSignal("docker-local", true, false, { handled: true, running: false }),
    ).toEqual({ status: "stopped", label: "Container", detail: null });
  });

  it("reports docker host state as unknown when Docker control is disabled/unavailable, not stopped", () => {
    const signal = buildHostSignal("docker-local", false, false, { handled: false });
    expect(signal.status).toBe("unknown");
    expect(signal.label).toBe("Container");
  });

  it("reports docker host state as unknown when no managed-container lookup was supplied at all", () => {
    expect(buildHostSignal("docker-local", true).status).toBe("unknown");
  });

  it("reports docker host state as unknown when the mapped container can't be resolved", () => {
    const signal = buildHostSignal("docker-local", false, false, {
      handled: true,
      container: null,
      error: 'Container "pz" is mapped to this server but the panel cannot manage it.',
    });
    expect(signal.status).toBe("unknown");
    expect(signal.detail).toMatch(/cannot manage it/);
  });

  it("falls back to not-applicable for an unrecognised provider", () => {
    expect(buildHostSignal("custom", true)).toEqual({
      status: "not-applicable",
      label: "Host",
      detail: null,
    });
  });

  it("reports native host state as unknown when detection itself failed, not stopped", () => {
    const signal = buildHostSignal("native", false, true);
    expect(signal.status).toBe("unknown");
    expect(signal.label).toBe("Process");
    expect(signal.detail).toBeTruthy();
  });

  it("does not report unknown for native when the scan succeeded and simply found nothing", () => {
    expect(buildHostSignal("native", false, false).status).toBe("stopped");
    expect(buildHostSignal("native", false).status).toBe("stopped");
  });

  it("does not let a stale isRunning:true smuggle a confirmed state past a failed scan", () => {
    expect(buildHostSignal("native", true, true).status).toBe("unknown");
  });
});

describe("buildServerSignal", () => {
  it("reports connected with host:port detail", () => {
    expect(
      buildServerSignal({ connected: true, host: "127.0.0.1", port: 27015 }),
    ).toEqual({ status: "connected", label: "RCON", detail: "127.0.0.1:27015" });
  });

  it("reports connecting when a connection attempt is in flight", () => {
    expect(buildServerSignal({ connected: false, connecting: true }).status).toBe(
      "connecting",
    );
  });

  it("defaults to disconnected", () => {
    expect(buildServerSignal({}).status).toBe("disconnected");
  });
});

describe("buildBridgeSignal", () => {
  it("reports not-installed when never configured", () => {
    expect(buildBridgeSignal({ configured: false }).status).toBe("not-installed");
  });

  it("reports active only when running and the mod is responding", () => {
    expect(
      buildBridgeSignal({ configured: true, running: true, modConnected: true })
        .status,
    ).toBe("active");
  });

  it("reports offline when configured but not fully connected", () => {
    expect(
      buildBridgeSignal({ configured: true, running: true, modConnected: false })
        .status,
    ).toBe("offline");
    expect(
      buildBridgeSignal({ configured: true, running: false, modConnected: false })
        .status,
    ).toBe("offline");
  });
});

describe("buildSummary", () => {
  it("reads as a plain-English one-liner", () => {
    const host = { status: "running", label: "Process" };
    const server = { status: "disconnected", label: "RCON" };
    expect(buildSummary(host, server)).toBe("Process running, RCON disconnected");
  });
});

describe("composeServerStatus", () => {
  it("composes the full docker-container-running-but-rcon-down scenario", () => {
    const result = composeServerStatus({
      server: { isRemote: false },
      isRunning: true,
      rcon: { connected: false, host: "host.docker.internal", port: 27015 },
      bridge: { configured: true, running: false, modConnected: false },
    });

    expect(result).toEqual({
      provider: "native",
      selected: true,
      host: { status: "running", label: "Process", detail: null },
      server: {
        status: "disconnected",
        label: "RCON",
        detail: "host.docker.internal:27015",
      },
      bridge: { status: "offline", label: "PanelBridge", detail: null },
      summary: "Process running, RCON disconnected",
    });
  });

  it("composes a fully healthy native server", () => {
    const result = composeServerStatus({
      server: { isRemote: false },
      isRunning: true,
      rcon: { connected: true, host: "127.0.0.1", port: 27015 },
      bridge: { configured: true, running: true, modConnected: true },
    });

    expect(result.host.status).toBe("running");
    expect(result.server.status).toBe("connected");
    expect(result.bridge.status).toBe("active");
    expect(result.selected).toBe(true);
  });

  it("composes a native server whose host state can't be verified because detection failed", () => {
    const result = composeServerStatus({
      server: { isRemote: false },
      isRunning: false,
      scanFailed: true,
      rcon: { connected: false },
      bridge: { configured: false },
    });

    expect(result.provider).toBe("native");
    expect(result.host.status).toBe("unknown");
  });

  it("composes a remote server whose host state can't be verified", () => {
    const result = composeServerStatus({
      server: { isRemote: true },
      isRunning: false,
      rcon: { connected: true, host: "1.2.3.4", port: 27015 },
      bridge: { configured: true, running: true, modConnected: true },
    });

    expect(result.provider).toBe("remote-sftp");
    expect(result.host.status).toBe("unknown");
    expect(result.server.status).toBe("connected");
  });

  it("reports a mapped container as running from the Docker lookup, even though the local process scan found nothing", () => {
    const result = composeServerStatus({
      server: { dockerContainerName: "pz-server" },
      isRunning: false,
      scanFailed: false,
      dockerContainer: { handled: true, ref: "pz-server", running: true },
      rcon: { connected: true, host: "pz-server", port: 27015 },
      bridge: { configured: true, running: true, modConnected: true },
    });

    expect(result.provider).toBe("docker-local");
    expect(result.host).toEqual({ status: "running", label: "Container", detail: null });
  });

  it("reports a mapped container as unknown, not stopped, when Docker control is disabled", () => {
    const result = composeServerStatus({
      server: { dockerContainerName: "pz-server" },
      isRunning: false,
      dockerContainer: { handled: false },
      rcon: { connected: false },
      bridge: { configured: false },
    });

    expect(result.provider).toBe("docker-local");
    expect(result.host.status).toBe("unknown");
  });
});
