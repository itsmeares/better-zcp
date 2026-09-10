import { describe, expect, it } from "vitest";
import {
  buildPanelInfo,
  selectPanelLocalIp,
} from "../utils/panelInfo.ts";

describe("panel info", () => {
  it("keeps the Express and Start response contract stable", () => {
    expect(buildPanelInfo("192.168.1.20", 3001)).toEqual({
      localIp: "192.168.1.20",
      port: 3001,
      url: "http://192.168.1.20:3001",
    });
  });

  it("only uses a selected LAN address when it belongs to this host", () => {
    const interfaces = [
      { name: "eth0", address: "192.168.1.20" },
      { name: "wlan0", address: "192.168.1.21" },
    ];

    expect(selectPanelLocalIp(interfaces, "192.168.1.21", null)).toBe(
      "192.168.1.21",
    );
    expect(selectPanelLocalIp(interfaces, "192.168.1.99", null)).toBe(
      "192.168.1.20",
    );
    expect(selectPanelLocalIp(interfaces, "192.168.1.99", "10.0.0.5")).toBe(
      "10.0.0.5",
    );
  });
});
