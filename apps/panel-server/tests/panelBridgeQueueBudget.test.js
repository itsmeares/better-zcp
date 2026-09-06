import { describe, expect, it } from "vitest";
import path from "path";
import { loadPanelBridge } from "./helpers/panelBridgeLua.js";

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

  // The two cases above pin the loop-bound half of the counter's job: a run
  // of garbage still consumes the per-tick scan budget, so the tick's file
  // I/O stays bounded no matter what's queued (see the split into
  // scanned/processed in processQueuedCommands and processCommands).
  // This case pins the OTHER half, which nothing previously covered: the
  // count actually RETURNED and LOGGED (processCommands' "Processed N
  // commands" debug line, PanelBridge.lua ~7509) must reflect only entries
  // processSingleCommand genuinely attempted, not every file scanned --
  // otherwise the reported number overstates real work, which is the
  // failure mode 036a538 was originally sent to fix (and would have kept
  // being wrong under the pre-036a538 source too, just via a different
  // mechanism -- see that commit's message).
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
    // All 10 entries were scanned and the cursor advanced past every one of
    // them -- confirms this case isn't accidentally exercising the budget
    // limit itself (10 is far under the 200-per-tick budget).
    expect(state.queueState.lastCommandSeq).toBe(10);
    // Internal stat, incremented on the same "attempted" path
    // processSingleCommand's return value gates -- corroborates the log
    // line below via a second, independent surface.
    expect(state.stats.commandsProcessed).toBe(3);
    // The actual line an operator would see. Only the 3 well-formed,
    // non-duplicate entries were genuinely attempted; the 7 malformed
    // entries were skipped, never dispatched to processSingleCommand.
    const processedLine = state.debugLog.find((e) => /^Processed \d+ commands$/.test(e.message));
    expect(processedLine?.message).toBe("Processed 3 commands");
  });
});