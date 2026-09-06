import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capability-gate cross-route-family sweep (Pam's structural finding,
// bug-hunt-2026-08-27): POST /command is the generic PanelBridge passthrough,
// gated bridge.command alone -- deliberately broad by the route's own
// comment, since it reaches every action including ~30 with no dedicated
// route at all. Four of those, moderationKickUser/BanUser/BanIP/BanSteamID,
// are different in kind: "discipline a player" is its own capability
// (players.moderate) everywhere else the app reaches it (players.js's own
// kick/ban/banid routes), specifically split from players.gm_tools because
// it carries a favouritism/griefing risk a GM tool doesn't. These four have
// no dedicated route of their own -- the only real caller is Events.tsx's
// "Moderation Automation" panel, via this exact endpoint -- so bridge.command
// was their ONLY gate. A custom role granted bridge.command for legitimate
// GM/world-event automation, but never granted players.moderate, got full
// kick/ban power as an undocumented side effect.

const getActiveServer = vi.fn(async () => null);
const logBridgeCommand = vi.fn(async () => {});

const ROLES = {
  admin: { capabilities: ["bridge.command", "players.moderate"] },
  // Holds bridge.command (passes the route's own gate) and NOTHING else --
  // the exact custom-role shape this fix exists to stop.
  bridge_command_only: { capabilities: ["bridge.command"] },
  // Holds bridge.command and players.gm_tools but NOT players.moderate --
  // the legitimate "GM/world-event automation" role the header comment
  // describes, used by the setGodMode/setInvisible/setNoclip/healPlayer
  // block below.
  gm_tools_admin: { capabilities: ["bridge.command", "players.gm_tools"] },
  // Holds ONLY players.gm_tools, no bridge.command -- the Technician shape
  // per an operator ruling (bug-hunt-2026-08-27, reverses c3083d5): this
  // role must now reach the GM-tools four through this passthrough despite
  // never holding bridge.command at all.
  gm_tools_only: { capabilities: ["players.gm_tools"] },
  // Holds bridge.command and bridge.diagnostics -- the shape debugItemScript
  // needs (ADDITIONAL semantics, same bucket as the moderation four, added
  // 2026-08-29 pin-literal-sendcommand-strings-against-valid-actions).
  bridge_diagnostics_admin: { capabilities: ["bridge.command", "bridge.diagnostics"] },
  // Holds ONLY players.endanger_or_impersonate, no bridge.command -- a role
  // that reaches the eight targeted zombie/sound/chat-impersonation actions
  // through their own dedicated routes today (2026-08-31 bug hunt fix) and
  // must keep reaching them through this passthrough too, REPLACEMENT
  // semantics same as gm_tools_only above.
  endanger_or_impersonate_only: { capabilities: ["players.endanger_or_impersonate"] },
  // Holds bridge.command and players.endanger_or_impersonate together.
  endanger_or_impersonate_admin: {
    capabilities: ["bridge.command", "players.endanger_or_impersonate"],
  },
};
const getRoleByName = vi.fn(async (name) => ROLES[name] || null);

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand,
  getRoleByName,
}));

const { default: bridge } = await import("../services/panelBridge.js");
const { default: router } = await import("../routes/panelBridge.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

// Every handler in the route's stack, in registration order -- e.g. for
// POST /command: [requireBridgeCommandUnlessGmToolsOnly, the real handler].
// getHandler() above only grabs the LAST one (skipping the gate ahead of
// it, same as every other file using this pattern); the GM-tools-only
// tests below need the gate too, since that's the piece that actually
// changed -- whether bridge.command is still required at the ROUTE level,
// not just in the inline BRIDGE_ACTION_CAPABILITY check further down.
function getStack(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack.map((entry) => entry.handle);
}

async function postCommand(action, args, role) {
  const res = createResponse();
  await getHandler("/command", "post")(
    { user: { role }, body: { action, args } },
    res,
    () => {},
  );
  return res;
}

// Runs the FULL middleware stack in registration order, stopping as soon as
// a handler doesn't call next() (i.e. it sent a response). Needed to prove
// the route-level gate itself (not just the inline handler logic
// postCommand() above exercises) behaves correctly for GM_TOOLS_ONLY_ACTIONS.
async function postCommandFullStack(action, args, role) {
  const res = createResponse();
  const req = { user: { role }, body: { action, args } };
  for (const handle of getStack("/command", "post")) {
    let calledNext = false;
    await handle(req, res, () => {
      calledNext = true;
    });
    if (!calledNext) break;
  }
  return res;
}

describe("POST /panel-bridge/command -- moderation actions require players.moderate in addition to bridge.command", () => {
  let sendCommand;

  beforeEach(() => {
    bridge.isRunning = true;
    bridge.bridgePath = "/fake/bridge/path";
    sendCommand = vi.spyOn(bridge, "sendCommand").mockResolvedValue({ success: true });
    getRoleByName.mockClear();
    logBridgeCommand.mockClear();
  });

  afterEach(() => {
    sendCommand.mockRestore();
    bridge.isRunning = false;
    bridge.bridgePath = null;
  });

  it.each([
    "moderationKickUser",
    "moderationBanUser",
    "moderationBanIP",
    "moderationBanSteamID",
  ])("refuses %s for a caller who holds bridge.command but not players.moderate", async (action) => {
    const res = await postCommand(action, { username: "Griefer" }, "bridge_command_only");

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PANELBRIDGE_ACTION_CAPABILITY_REQUIRED" }),
    );
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it.each([
    "moderationKickUser",
    "moderationBanUser",
    "moderationBanIP",
    "moderationBanSteamID",
  ])("allows %s for a caller who holds both bridge.command and players.moderate", async (action) => {
    const res = await postCommand(action, { username: "Griefer" }, "admin");

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(sendCommand).toHaveBeenCalledWith(action, { username: "Griefer" });
  });

  it("a non-moderation action (e.g. teleportPlayer) needs nothing beyond bridge.command itself", async () => {
    const res = await postCommand("teleportPlayer", { username: "Bob", x: 100, y: 100, z: 0 }, "bridge_command_only");

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(sendCommand).toHaveBeenCalledWith("teleportPlayer", { username: "Bob", x: 100, y: 100, z: 0 });
    // The router's own bridge.command gate already ran before this handler
    // (skipped here per this file's own harness, same as panelBridgeErrorParams.test.js) --
    // this assertion is about the INLINE check inside the handler only:
    // a non-mapped action must never trigger a second role lookup at all.
    expect(getRoleByName).not.toHaveBeenCalled();
  });
});

// debugItemScript, added to VALID_ACTIONS 2026-08-29 (backlog card
// pin-literal-sendcommand-strings-against-valid-actions) alongside this
// BRIDGE_ACTION_CAPABILITY entry, in the SAME commit -- without the
// capability entry, adding it to VALID_ACTIONS alone would have reopened
// the exact bypass this file exists to guard: any bridge_command_only
// caller reaching a sensitive action through the generic passthrough that
// its own dedicated route (POST /catalog/debug-item-script) gates more
// tightly (bridge.diagnostics alone, there).
describe("POST /panel-bridge/command -- debugItemScript requires bridge.diagnostics in addition to bridge.command", () => {
  let sendCommand;

  beforeEach(() => {
    bridge.isRunning = true;
    bridge.bridgePath = "/fake/bridge/path";
    sendCommand = vi.spyOn(bridge, "sendCommand").mockResolvedValue({ success: true });
    getRoleByName.mockClear();
  });

  afterEach(() => {
    sendCommand.mockRestore();
    bridge.isRunning = false;
    bridge.bridgePath = null;
  });

  it("refuses debugItemScript for a caller who holds bridge.command but not bridge.diagnostics", async () => {
    const res = await postCommand("debugItemScript", {}, "bridge_command_only");

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PANELBRIDGE_ACTION_CAPABILITY_REQUIRED" }),
    );
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("allows debugItemScript for a caller who holds both bridge.command and bridge.diagnostics", async () => {
    const res = await postCommand("debugItemScript", {}, "bridge_diagnostics_admin");

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(sendCommand).toHaveBeenCalledWith("debugItemScript", {});
  });
});

// bug-hunt-2026-08-27, were-the-dedicated-gm-tools-routes-ever-wired: unlike
// the moderation four, setGodMode/setInvisible/setNoclip/healPlayer each
// have their own dedicated, correctly-gated players.gm_tools route
// (players.js's /godmode, /invisible, /noclip; this file's own
// /players/:username/heal) -- but Players.tsx hasn't called any of them
// since commit 8bd0edc ("Release v1.0.2") silently moved three of the four
// onto this passthrough (and built the fourth, heal, against the
// passthrough from the start) as a side effect of an unrelated UI-overhaul
// release commit.
//
// This describe block previously proved these four need BOTH bridge.command
// AND players.gm_tools (server commit c3083d5). An operator ruling the same
// day SUPERSEDED that: players.gm_tools ALONE is now sufficient, and
// bridge.command is not required at all for these four -- c3083d5's combined
// requirement was never the intended fix, and denied Technician (who holds
// gm_tools but not bridge.command by default) the GM tools it's meant to
// have. The "requires BOTH" tests that used to live here were correct for
// the code as it stood, and are now testing the wrong thing; replaced
// below rather than patched to keep passing.
describe("POST /panel-bridge/command -- setGodMode/setInvisible/setNoclip/healPlayer require players.gm_tools ALONE, not bridge.command", () => {
  let sendCommand;

  beforeEach(() => {
    bridge.isRunning = true;
    bridge.bridgePath = "/fake/bridge/path";
    sendCommand = vi.spyOn(bridge, "sendCommand").mockResolvedValue({ success: true });
    getRoleByName.mockClear();
    logBridgeCommand.mockClear();
  });

  afterEach(() => {
    sendCommand.mockRestore();
    bridge.isRunning = false;
    bridge.bridgePath = null;
  });

  const GM_TOOLS_ACTIONS = ["setGodMode", "setInvisible", "setNoclip", "healPlayer"];
  const argsFor = (action) =>
    action === "healPlayer"
      ? { username: "Survivor" }
      : { username: "Survivor", enabled: true };

  it.each(GM_TOOLS_ACTIONS)(
    "refuses %s for a caller who holds bridge.command but not players.gm_tools (inline check)",
    async (action) => {
      const res = await postCommand(action, argsFor(action), "bridge_command_only");

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "PANELBRIDGE_ACTION_CAPABILITY_REQUIRED" }),
      );
      expect(sendCommand).not.toHaveBeenCalled();
    },
  );

  it.each(GM_TOOLS_ACTIONS)(
    "still refuses %s for a caller who holds players.moderate but not players.gm_tools (the moderation grant doesn't leak into GM tools)",
    async (action) => {
      const res = await postCommand(action, argsFor(action), "admin");

      expect(res.status).toHaveBeenCalledWith(403);
      expect(sendCommand).not.toHaveBeenCalled();
    },
  );

  // The three tests below run the FULL route stack (postCommandFullStack),
  // not just the last handler -- they're specifically proving the
  // route-level gate (requireBridgeCommandUnlessGmToolsOnly) skips
  // bridge.command for these four, which postCommand()'s
  // skip-straight-to-the-last-handler pattern can't see at all.

  it.each(GM_TOOLS_ACTIONS)(
    "allows %s through the FULL route stack for a caller who holds ONLY players.gm_tools, no bridge.command (Technician shape)",
    async (action) => {
      const args = argsFor(action);
      const res = await postCommandFullStack(action, args, "gm_tools_only");

      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(res.status).not.toHaveBeenCalledWith(401);
      expect(sendCommand).toHaveBeenCalledWith(action, args);
    },
  );

  it.each(GM_TOOLS_ACTIONS)(
    "refuses %s through the FULL route stack for a caller who holds ONLY bridge.command, no players.gm_tools",
    async (action) => {
      const res = await postCommandFullStack(action, argsFor(action), "bridge_command_only");

      expect(res.status).toHaveBeenCalledWith(403);
      expect(sendCommand).not.toHaveBeenCalled();
    },
  );

  it.each(GM_TOOLS_ACTIONS)(
    "allows %s through the FULL route stack for a caller who holds both bridge.command and players.gm_tools",
    async (action) => {
      const args = argsFor(action);
      const res = await postCommandFullStack(action, args, "gm_tools_admin");

      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(sendCommand).toHaveBeenCalledWith(action, args);
    },
  );

  it("a non-GM-tools action (e.g. moderationKickUser) still needs bridge.command through the FULL route stack even for a gm_tools-only caller", async () => {
    const res = await postCommandFullStack("moderationKickUser", { username: "Griefer" }, "gm_tools_only");

    expect(res.status).toHaveBeenCalledWith(403);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});

// 2026-08-31 bug hunt: playSoundNearPlayer/triggerGunshot/triggerAlarmSound/
// createNoise/spawnHordeNearPlayer/spawnHordeBehindPlayer/sendToAdminChat/
// sendToGeneralChat are the same eight actions the 2026-08-27 ranked-bug #5
// ruling moved off server.world_events onto players.endanger_or_impersonate
// for their OWN dedicated routes (/sound/near-player, /sound/gunshot,
// /sound/alarm, /sound/noise, /zombies/spawn-near, /zombies/spawn-behind,
// /chat/admin, /chat/general -- see playerEndangerOrImpersonateCapability
// .test.js). This generic passthrough was never updated to match: a role
// holding only bridge.command reached targeted zombie-spawning, targeted
// sound effects, and chat impersonation-as-server/admin through POST
// /command with no endanger_or_impersonate check at all. Fixed with
// REPLACEMENT semantics (ENDANGER_OR_IMPERSONATE_ONLY_ACTIONS), same shape
// as the GM four above and for the same reason: their dedicated routes
// require players.endanger_or_impersonate ALONE, so ADDITIONAL semantics
// here would have newly 403'd a role that already reaches all eight through
// those dedicated routes today.
describe("POST /panel-bridge/command -- the eight endanger_or_impersonate actions require players.endanger_or_impersonate ALONE, not bridge.command", () => {
  let sendCommand;

  beforeEach(() => {
    bridge.isRunning = true;
    bridge.bridgePath = "/fake/bridge/path";
    sendCommand = vi.spyOn(bridge, "sendCommand").mockResolvedValue({ success: true });
    getRoleByName.mockClear();
    logBridgeCommand.mockClear();
  });

  afterEach(() => {
    sendCommand.mockRestore();
    bridge.isRunning = false;
    bridge.bridgePath = null;
  });

  const ENDANGER_ACTIONS = [
    "playSoundNearPlayer",
    "triggerGunshot",
    "triggerAlarmSound",
    "createNoise",
    "spawnHordeNearPlayer",
    "spawnHordeBehindPlayer",
    "sendToAdminChat",
    "sendToGeneralChat",
  ];
  const argsFor = (action) =>
    action === "sendToAdminChat" || action === "sendToGeneralChat"
      ? { message: "This is an announcement." }
      : { username: "Survivor" };

  it.each(ENDANGER_ACTIONS)(
    "refuses %s for a caller who holds bridge.command but not players.endanger_or_impersonate (inline check)",
    async (action) => {
      const res = await postCommand(action, argsFor(action), "bridge_command_only");

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "PANELBRIDGE_ACTION_CAPABILITY_REQUIRED" }),
      );
      expect(sendCommand).not.toHaveBeenCalled();
    },
  );

  it.each(ENDANGER_ACTIONS)(
    "still refuses %s for a caller who holds players.moderate but not players.endanger_or_impersonate (the moderation grant doesn't leak in)",
    async (action) => {
      const res = await postCommand(action, argsFor(action), "admin");

      expect(res.status).toHaveBeenCalledWith(403);
      expect(sendCommand).not.toHaveBeenCalled();
    },
  );

  // The three tests below run the FULL route stack (postCommandFullStack),
  // proving the route-level gate (requireBridgeCommandUnlessGmToolsOnly)
  // skips bridge.command for these eight, which postCommand()'s
  // skip-straight-to-the-last-handler pattern can't see at all.

  it.each(ENDANGER_ACTIONS)(
    "allows %s through the FULL route stack for a caller who holds ONLY players.endanger_or_impersonate, no bridge.command",
    async (action) => {
      const args = argsFor(action);
      const res = await postCommandFullStack(action, args, "endanger_or_impersonate_only");

      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(res.status).not.toHaveBeenCalledWith(401);
      expect(sendCommand).toHaveBeenCalledWith(action, args);
    },
  );

  it.each(ENDANGER_ACTIONS)(
    "refuses %s through the FULL route stack for a caller who holds ONLY bridge.command, no players.endanger_or_impersonate -- the bypass this fix closes",
    async (action) => {
      const res = await postCommandFullStack(action, argsFor(action), "bridge_command_only");

      expect(res.status).toHaveBeenCalledWith(403);
      expect(sendCommand).not.toHaveBeenCalled();
    },
  );

  it.each(ENDANGER_ACTIONS)(
    "allows %s through the FULL route stack for a caller who holds both bridge.command and players.endanger_or_impersonate",
    async (action) => {
      const args = argsFor(action);
      const res = await postCommandFullStack(action, args, "endanger_or_impersonate_admin");

      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(sendCommand).toHaveBeenCalledWith(action, args);
    },
  );

  it("a non-endanger_or_impersonate action (e.g. teleportPlayer) still needs only bridge.command through the FULL route stack even for an endanger_or_impersonate-only caller", async () => {
    const res = await postCommandFullStack(
      "teleportPlayer",
      { username: "Bob", x: 100, y: 100, z: 0 },
      "endanger_or_impersonate_only",
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
