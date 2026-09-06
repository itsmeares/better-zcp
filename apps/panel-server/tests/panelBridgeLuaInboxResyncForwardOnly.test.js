import { describe, expect, it } from "vitest";
import path from "path";
import { loadPanelBridge } from "./helpers/panelBridgeLua.js";

const LUA_PATH = path.resolve(
  "integrations/panelbridge/PanelBridge/media/lua/server/PanelBridge.lua",
);

// A controllable clock (NOW, mutated between bridge.run() calls) instead of
// the fixed getTimestampMs=0 stub other tests use -- these tests need to
// cross the stuck-detection window, not just take a single snapshot in time.
const FILE_STUBS = `
FILES = {}
NOW = 0
getTimestampMs = function() return NOW end
function getServerName() return "TestServer" end
function getFileReader(path)
  local value = FILES[path]
  if value == nil then return nil end
  local reader = { value = value, done = false }
  function reader:readLine()
    if self.done then return nil end
    self.done = true
    return self.value
  end
  function reader:close() end
  return reader
end
function getFileWriter(path)
  local writer = { path = path, value = "" }
  function writer:write(value) self.value = self.value .. value end
  function writer:close() FILES[self.path] = self.value end
  return writer
end
`;

// 2026-08-30 (bridge-resync-threshold-transport-aware): tryResyncInboxCursor
// (PanelBridge.lua, ~line 1666) reads the panel's declared write position
// from .queue-state-node.json and, once the inbox has been stalled long
// enough to case a genuine desync, adopts it as this process's own
// lastCommandSeq. Before this fix it did so UNCONDITIONALLY -- if that
// file's value was ever lower than what this process had already
// legitimately processed (a stale read, or a second writer overwriting it
// with an older value -- exactly what four zombie nodemon-wrapped panel
// processes sharing one bridge folder did for real earlier the same day),
// the mod would rewind its own cursor BACKWARD and reprocess already
// executed commands. These tests pin the forward-only guard that makes that
// direction structurally impossible, and confirm the legitimate forward
// case (panel genuinely ahead of what this process ever wrote) still
// self-heals exactly as before.
describe("PanelBridge.lua inbox resync -- forward-only guard", () => {
  it("still catches up forward when the panel is genuinely ahead", () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    bridge.run(`PanelBridgeModule.queueState.lastCommandSeq = 5`);

    // First tick: inbox/cmd-0000000006.json doesn't exist yet -- this starts
    // the stuck-detection window (no command has ever been seen for seq 6).
    bridge.run(`PanelBridgeModule.processCommands()`);

    // Advance well past the stuck window (whatever its exact value), and
    // declare the panel has genuinely written through seq 10.
    bridge.run(`
      NOW = NOW + 999999
      FILES["panelbridge/TestServer/.queue-state-node.json"] =
        '{"nextCommandSeq":11}'
      PanelBridgeModule.processCommands()
    `);

    const state = bridge.getGlobal("PanelBridgeModule");
    expect(state.queueState.lastCommandSeq).toBe(10);
  });

  it("refuses to move the cursor backward when the panel's declared position is lower than what this process already processed", () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    bridge.run(`PanelBridgeModule.queueState.lastCommandSeq = 50`);

    bridge.run(`PanelBridgeModule.processCommands()`);

    // A stale or racing write of .queue-state-node.json claims the panel is
    // only through seq 10 -- lower than the 50 this process has already
    // genuinely consumed. Trusting this would replay 40 already-processed
    // commands.
    bridge.run(`
      NOW = NOW + 999999
      FILES["panelbridge/TestServer/.queue-state-node.json"] =
        '{"nextCommandSeq":11}'
      PanelBridgeModule.processCommands()
    `);

    const state = bridge.getGlobal("PanelBridgeModule");
    expect(state.queueState.lastCommandSeq).toBe(50);
  });
});
