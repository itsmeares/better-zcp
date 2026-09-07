import { describe, expect, it } from "vitest";
import path from "path";
import { loadPanelBridge } from "./helpers/panelBridgeLua.ts";

const LUA_PATH = path.resolve(
  "integrations/panelbridge/PanelBridge/media/lua/server/PanelBridge.lua",
);

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

describe("PanelBridge.lua inbox resync -- forward-only guard", () => {
  it("still catches up forward when the panel is genuinely ahead", () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    bridge.run(`PanelBridgeModule.queueState.lastCommandSeq = 5`);

    bridge.run(`PanelBridgeModule.processCommands()`);

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
