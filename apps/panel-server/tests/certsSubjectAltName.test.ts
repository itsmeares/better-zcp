import crypto from "crypto";
import fs from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockPaths = vi.hoisted(() => ({
  dataDir: `/tmp/zcp-cert-test-${process.pid}`,
  logsDir: `/tmp/zcp-cert-test-${process.pid}/logs`,
}));
const networkInterfacesMock = vi.hoisted(() => vi.fn());

vi.mock("../utils/paths.ts", () => ({ getDataPaths: () => mockPaths }));
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    default: { ...actual.default, networkInterfaces: networkInterfacesMock },
    networkInterfaces: networkInterfacesMock,
  };
});

const { loadOrCreateCerts } = await import("../utils/certs.ts");

function interfaces(addresses: string[]) {
  return Object.fromEntries(
    addresses.map((address, index) => [
      `iface${index}`,
      [{ address, family: "IPv4", internal: false }],
    ]),
  );
}

afterEach(() => {
  networkInterfacesMock.mockReset();
  fs.rmSync(mockPaths.dataDir, { recursive: true, force: true });
  fs.mkdirSync(mockPaths.dataDir, { recursive: true });
});

describe("self-signed certificate SANs", () => {
  it("includes localhost, loopback, and current non-internal IPv4 addresses", () => {
    networkInterfacesMock.mockReturnValue(interfaces(["192.168.1.50"]));

    const certs = loadOrCreateCerts();
    const x509 = new crypto.X509Certificate(certs.cert);

    expect(x509.subjectAltName).toContain("DNS:localhost");
    expect(x509.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(x509.subjectAltName).toContain("IP Address:192.168.1.50");
  });

  it("regenerates when a new current interface is missing from the cached certificate", () => {
    networkInterfacesMock.mockReturnValue(interfaces(["192.168.1.50"]));
    const first = loadOrCreateCerts();

    networkInterfacesMock.mockReturnValue(interfaces(["192.168.1.50", "100.64.1.2"]));
    const second = loadOrCreateCerts();

    expect(second.cert.toString()).not.toBe(first.cert.toString());
    expect(new crypto.X509Certificate(second.cert).subjectAltName).toContain(
      "IP Address:100.64.1.2",
    );
  });

  it("keeps the cached certificate when only a previously-present interface disappears", () => {
    networkInterfacesMock.mockReturnValue(interfaces(["192.168.1.50", "100.64.1.2"]));
    const first = loadOrCreateCerts();

    networkInterfacesMock.mockReturnValue(interfaces(["192.168.1.50"]));
    const second = loadOrCreateCerts();

    expect(second.cert.toString()).toBe(first.cert.toString());
    expect(second.key.toString()).toBe(first.key.toString());
  });
});
