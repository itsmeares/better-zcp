import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const getActiveServer = vi.fn(async () => null);
const logBridgeCommand = vi.fn(async () => {});

const ROLES = {
  admin: { capabilities: ["bridge.command", "players.moderate"] },
  bridge_command_only: { capabilities: ["bridge.command"] },
  gm_tools_admin: { capabilities: ["bridge.command", "players.gm_tools"] },
  gm_tools_only: { capabilities: ["players.gm_tools"] },
  bridge_diagnostics_admin: { capabilities: ["bridge.command", "bridge.diagnostics"] },
  endanger_or_impersonate_only: { capabilities: ["players.endanger_or_impersonate"] },
  endanger_or_impersonate_admin: {
    capabilities: ["bridge.command", "players.endanger_or_impersonate"],
  },
};
const getRoleByName = vi.fn(async (name) => ROLES[name] || null);

vi.mock("../database/init.ts", () => ({
  getActiveServer,
  getServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand,
  getRoleByName,
}));

const { default: bridge } = await import("../services/panelBridge.ts");
const { default: router } = await import("../routes/panelBridge.ts");

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
    expect(getRoleByName).not.toHaveBeenCalled();
  });
});

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
