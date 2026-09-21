import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");

describe("AIRDROP_PRESETS (client) vs airdrop's VALID_PRESETS (server): parity", () => {
  const CLIENT_PATH = "apps/panel-client/src/pages/WorldMap.tsx";
  const SERVER_PATH = "apps/panel-server/routes/panelBridge.ts";

  function extractAirdropPresetIds() {
    const content = fs.readFileSync(path.join(ROOT, CLIENT_PATH), "utf-8");
    const arrayMatch = content.match(/const AIRDROP_PRESETS = \[([\s\S]*?)\] as const/);
    if (!arrayMatch) return null;
    return [...arrayMatch[1].matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
  }

  function extractValidPresets() {
    const content = fs.readFileSync(path.join(ROOT, SERVER_PATH), "utf-8");
    const arrayMatch = content.match(/const VALID_PRESETS = \[([^\]]*)\]/);
    if (!arrayMatch) return null;
    return arrayMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^['"]|['"]$/g, ""));
  }

  it(`${CLIENT_PATH}'s AIRDROP_PRESETS ids match ${SERVER_PATH}'s VALID_PRESETS exactly`, () => {
    const clientIds = extractAirdropPresetIds();
    const serverIds = extractValidPresets();
    expect(
      clientIds,
      `could not find "const AIRDROP_PRESETS = [...] as const" in ${CLIENT_PATH} -- the extraction regex needs updating, not this test relaxing`,
    ).not.toBeNull();
    expect(
      serverIds,
      `could not find "const VALID_PRESETS = [...]" in ${SERVER_PATH} -- the extraction regex needs updating, not this test relaxing`,
    ).not.toBeNull();
    expect(
      clientIds,
      "the airdrop preset picker and the server's accepted preset list have drifted apart -- the UI would offer a preset the server's airdrop validation (PANELBRIDGE_AIRDROP_INVALID_PRESET) then rejects, or hide one the server accepts",
    ).toEqual(serverIds);
  });
});

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
