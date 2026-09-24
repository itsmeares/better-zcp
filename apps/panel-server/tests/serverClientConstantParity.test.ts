import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vite-plus/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");

describe("DISK_SOCKET_EVENTS (client) vs diskMonitor's io.emit() calls (server): parity", () => {
  const CLIENT_PATH = "apps/panel-client/src/components/SystemHealthBanner.tsx";
  const SERVER_PATH = "apps/panel-server/services/diskMonitor.ts";

  function extractClientDiskEvents() {
    const content = fs.readFileSync(path.join(ROOT, CLIENT_PATH), "utf-8");
    const match = content.match(/const DISK_SOCKET_EVENTS = \[([^\]]*)\]/);
    if (!match) return null;
    return match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^['"]|['"]$/g, ""))
      .sort();
  }

  function extractServerDiskEvents() {
    const content = fs.readFileSync(path.join(ROOT, SERVER_PATH), "utf-8");
    const events = new Set([...content.matchAll(/\.io\.emit\(\s*["'](disk:[a-zA-Z]+)["']/g)].map((m) => m[1]));
    return [...events].sort();
  }

  it(`${CLIENT_PATH}'s DISK_SOCKET_EVENTS matches every "disk:*" event ${SERVER_PATH} actually emits`, () => {
    const clientEvents = extractClientDiskEvents();
    const serverEvents = extractServerDiskEvents();
    expect(
      clientEvents,
      `could not find "const DISK_SOCKET_EVENTS = [...]" in ${CLIENT_PATH} -- the extraction regex needs updating, not this test relaxing`,
    ).not.toBeNull();
    expect(
      serverEvents.length,
      `found zero "this.io.emit(\\"disk:...\\"` + `)" call sites in ${SERVER_PATH} -- the extraction regex needs updating, not this test relaxing`,
    ).toBeGreaterThan(0);
    expect(
      clientEvents,
      "the client's disk-event listener list and the server's actual disk:* emit() call sites have drifted apart -- a renamed or newly added disk event would silently never trigger a refresh in the banner",
    ).toEqual(serverEvents);
  });
});
