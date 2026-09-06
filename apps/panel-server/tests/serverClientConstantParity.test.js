import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { DEFAULT_INI_EXCLUSIONS } from "../utils/templateSchema.js";
import { USER_ROLES } from "../services/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");

function extractArrayLiteral(relativePath, constName) {
  const content = fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
  const re = new RegExp(`const ${constName}\\s*=\\s*\\[([^\\]]*)\\]`);
  const match = content.match(re);
  if (!match) return null;
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^['"]|['"]$/g, ""));
}

describe("TEMPLATE_INI_EXCLUSIONS (client) vs DEFAULT_INI_EXCLUSIONS (server): parity", () => {
  const CLIENT_PATH = "apps/panel-client/src/lib/templateBuilder.ts";

  it(`${CLIENT_PATH}'s TEMPLATE_INI_EXCLUSIONS matches server's DEFAULT_INI_EXCLUSIONS exactly`, () => {
    const clientList = extractArrayLiteral(CLIENT_PATH, "TEMPLATE_INI_EXCLUSIONS");
    expect(
      clientList,
      `could not find "const TEMPLATE_INI_EXCLUSIONS = [...]" in ${CLIENT_PATH} -- the extraction regex needs updating, not this test relaxing`,
    ).not.toBeNull();
    expect(
      clientList,
      "client and server ini-exclusion lists have drifted apart -- the client will build a template payload the server's validateTemplate() then rejects (serverIni must not contain excluded keys), a confusing UX regression even though it can't leak a secret",
    ).toEqual(DEFAULT_INI_EXCLUSIONS);
  });
});

describe("LEGACY_USER_ROLES (client) vs USER_ROLES (server): parity", () => {
  const CLIENT_PATH = "apps/panel-client/src/pages/Users.tsx";

  it(`${CLIENT_PATH}'s LEGACY_USER_ROLES matches server's USER_ROLES exactly`, () => {
    const clientList = extractArrayLiteral(CLIENT_PATH, "LEGACY_USER_ROLES");
    expect(
      clientList,
      `could not find "const LEGACY_USER_ROLES = [...]" in ${CLIENT_PATH} -- the extraction regex needs updating, not this test relaxing`,
    ).not.toBeNull();
    expect(
      clientList,
      "client and server legacy-role lists have drifted apart -- POST /api/auth/users would reject a role the client dropdown still offers, or the dropdown would be missing one the server accepts",
    ).toEqual(USER_ROLES);
  });
});


describe("AIRDROP_PRESETS (client) vs airdrop's VALID_PRESETS (server): parity", () => {
  const CLIENT_PATH = "apps/panel-client/src/pages/WorldMap.tsx";
  const SERVER_PATH = "apps/panel-server/routes/panelBridge.js";

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
  const SERVER_PATH = "apps/panel-server/services/diskMonitor.js";

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
