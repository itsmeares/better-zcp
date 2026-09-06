import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { DEFAULT_INI_EXCLUSIONS } from "../utils/templateSchema.js";
import { USER_ROLES } from "../services/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");

// regression-2026-08-30: generalizes accessLevelsListParity.test.js's
// technique after that survey found two MORE server/client constant pairs
// that are hand-duplicated (a different array, by hand, in a different
// language, because server code isn't in the client bundle) with nothing
// enforcing agreement -- exactly the shape ACCESS_LEVELS had drifted into
// before that fix. Both pairs are confirmed IN SYNC as of this commit; this
// is pure guard installation, no behavior change.
//
// Same text-extraction technique as panelBridgeSendCommandLiteralsMatchValidActions.test.js
// and accessLevelsListParity.test.js: the client file is TS/TSX, not
// importable into this server-side vitest run without a build step, so its
// array literal is read as text and regex-extracted instead.
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
  // DEFAULT_INI_EXCLUSIONS's own comment (apps/panel-server/utils/templateSchema.js)
  // documents a real past incident in this exact domain (2026-08-24
  // regression): a template's own (attacker-controlled)
  // iniExclusions list was once trusted as authoritative at the apply-time
  // write site, letting an empty list disable the RCONPassword/port/
  // ServerName protection entirely. Fixed there by resolveIniExclusions()
  // always unioning in DEFAULT_INI_EXCLUSIONS unconditionally -- confirmed
  // (regression) that the SAME unconditional union backs
  // validateTemplate()'s check on every saveTemplate()/importTemplate()
  // call, so a drifted CLIENT copy cannot itself leak a secret into a
  // saved/exported template: the server independently rejects (400,
  // SIM_TEMPLATE_VALIDATION_FAILED) any excluded key present in
  // template.serverIni, regardless of what the client stripped first. A
  // drift here is a confusing validation-error UX, not a secret leak --
  // still worth guarding so that error never happens, just not urgent.
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
  // apps/panel-client/src/pages/Users.tsx's own comment already explains why this
  // exists: POST /api/auth/users only accepts one of these three legacy
  // names (no roleId param at creation time). Nothing enforced the two
  // staying in sync before this.
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

// regression-2026-08-30: closes out duplication-survey-uncovered-remainder
// (the not-covered list regression's survey named rather than glossing
// over). Two more real pairs found by finally scanning apps/panel-server/routes/*.js
// and apps/panel-server/index.js (never checked before) and opening the remaining
// name-scanned-but-unopened client constants. Both confirmed IN SYNC as of
// this commit -- pure guard installation, no behavior change. Everything
// else on that not-covered list was checked and rejected with a reason (see
// the survey report), not silently dropped.

describe("AIRDROP_PRESETS (client) vs airdrop's VALID_PRESETS (server): parity", () => {
  // apps/panel-client/src/pages/WorldMap.tsx's AIRDROP_PRESETS is `[{ id, icon }, ...]`,
  // not a flat string array -- extract just the id field. apps/panel-server/routes/
  // panelBridge.js's VALID_PRESETS lives INSIDE the POST /command handler
  // (not a module-level export), so it's regex-extracted too rather than
  // imported, same reasoning as the client side.
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
  // apps/panel-client/src/components/SystemHealthBanner.tsx literally iterates this
  // array to bind/unbind socket listeners (DISK_SOCKET_EVENTS.forEach((evt)
  // => socket.on(evt, refresh))) -- not just a UI label list, a real event
  // subscription contract. apps/panel-server/services/diskMonitor.js has no single
  // named export enumerating its event names; it emits them at three
  // separate call sites, so the server side is reconstructed from those
  // call sites rather than imported.
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
