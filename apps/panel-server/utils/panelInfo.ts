import net from "node:net";
import { listNonInternalIPv4Interfaces } from "./networkInterfaces.ts";

type PanelEnvironment = Record<string, string | undefined>;
type PanelSettingReader = (key: string) => Promise<unknown>;
type NonInternalIpv4Interface = ReturnType<typeof listNonInternalIPv4Interfaces>[number];

export interface PanelInfo {
  localIp: string;
  port: number;
  url: string;
}

export function resolvePanelPort(
  rawValue: unknown,
  { onInvalid }: { onInvalid?: (value: unknown) => void } = {},
): number {
  const configuredPort = Number(rawValue);
  if (
    Number.isInteger(configuredPort) &&
    configuredPort >= 1 &&
    configuredPort <= 65535
  ) {
    return configuredPort;
  }

  if (
    rawValue !== undefined &&
    rawValue !== null &&
    String(rawValue).trim() !== ""
  ) {
    onInvalid?.(rawValue);
  }
  return 3001;
}

export function resolvePanelInfoPort(savedPort: unknown): number {
  const configuredPort = getProcessEnvironment().PORT;
  return resolvePanelPort(configuredPort || savedPort || 3001);
}

export function buildPanelInfo(localIp: string, port: number): PanelInfo {
  return {
    localIp,
    port,
    url: `http://${localIp}:${port}`,
  };
}

export function selectPanelLocalIp(
  interfaces: NonInternalIpv4Interface[],
  selectedSetting: unknown,
  configuredLanIp: string | null,
): string {
  if (
    typeof selectedSetting === "string" &&
    interfaces.some((iface) => iface.address === selectedSetting)
  ) {
    return selectedSetting;
  }

  return configuredLanIp || interfaces[0]?.address || "127.0.0.1";
}

function getProcessEnvironment(): PanelEnvironment {
  return (
    (globalThis as typeof globalThis & {
      process?: { env?: PanelEnvironment };
    }).process?.env ?? {}
  );
}

export function getConfiguredIpv4Address(
  variableName: string,
  environment: PanelEnvironment = getProcessEnvironment(),
): string | null {
  const address = environment[variableName]?.trim();
  return address && net.isIP(address) === 4 ? address : null;
}

export async function resolvePanelLocalIp(
  readSetting: PanelSettingReader,
): Promise<string> {
  const interfaces = listNonInternalIPv4Interfaces();
  let selectedSetting: unknown = null;

  try {
    selectedSetting = await readSetting("lanIpAddress");
  } catch {
    // Network discovery should still work if the settings store is unavailable.
  }

  return selectPanelLocalIp(
    interfaces,
    selectedSetting,
    getConfiguredIpv4Address("PANEL_LAN_IP"),
  );
}
