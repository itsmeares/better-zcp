import { describe, expect, it } from "vitest";
import path from "path";
import { loadPanelBridge } from "./helpers/panelBridgeLua.ts";

const LUA_PATH = path.resolve(
  "integrations/panelbridge/PanelBridge/media/lua/server/PanelBridge.lua",
);

const FILE_STUBS = `
FILES = {}
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

describe("PanelBridge command budget", () => {
  it("counts duplicate entries toward the per-tick queue budget", () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    bridge.run(`
      for i = 1, 205 do
        local seq = string.format("%010d", i)
        FILES["panelbridge/TestServer/inbox/cmd-" .. seq .. ".json"] =
          '{"seq":' .. tostring(i) .. ',"id":"duplicate","action":"unknown"}'
      end
      PanelBridgeModule.processCommands()
    `);

    const queueState = bridge.getGlobal("PanelBridgeModule").queueState;
    expect(queueState.lastCommandSeq).toBe(200);
  });

  it("counts malformed entries toward the per-tick queue budget", () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    bridge.run(`
      for i = 1, 205 do
        local seq = string.format("%010d", i)
        FILES["panelbridge/TestServer/inbox/cmd-" .. seq .. ".json"] = "not-json"
      end
      PanelBridgeModule.processCommands()
    `);

    const queueState = bridge.getGlobal("PanelBridgeModule").queueState;
    expect(queueState.lastCommandSeq).toBe(200);
  });

  it("the reported processed count excludes scanned-but-skipped entries", () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    bridge.run(`
      for i = 1, 3 do
        local seq = string.format("%010d", i)
        FILES["panelbridge/TestServer/inbox/cmd-" .. seq .. ".json"] =
          '{"id":"real-' .. i .. '","action":"unknown"}'
      end
      for i = 4, 10 do
        local seq = string.format("%010d", i)
        FILES["panelbridge/TestServer/inbox/cmd-" .. seq .. ".json"] = "not-json"
      end
      PanelBridgeModule.processCommands()
    `);

    const state = bridge.getGlobal("PanelBridgeModule");
    expect(state.queueState.lastCommandSeq).toBe(10);
    expect(state.stats.commandsProcessed).toBe(3);
    const processedLine = state.debugLog.find((e) => /^Processed \d+ commands$/.test(e.message));
    expect(processedLine?.message).toBe("Processed 3 commands");
  });
});