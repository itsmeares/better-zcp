import os from "os";

export interface NonInternalIpv4Interface {
  name: string;
  address: string;
}

export function listNonInternalIPv4Interfaces(): NonInternalIpv4Interface[] {
  const interfaces = os.networkInterfaces();
  const result: NonInternalIpv4Interface[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        result.push({ name, address: iface.address });
      }
    }
  }
  return result;
}
