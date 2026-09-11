import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadPanelBridge } from './helpers/panelBridgeLua.ts';

const LUA_PATH = path.resolve(
  'integrations/panelbridge/PanelBridge/media/lua/server/PanelBridge.lua',
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
`;

describe('PanelBridge.lua readJSON guard', () => {
  it('treats a decoder failure as absent state instead of throwing from the tick', () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);

    bridge.run(`
      FILES["panelbridge/TestServer/state.json"] = '{}'
      PanelBridgeModule.json.decode = function() error("simulated decoder failure") end
      __READ_OK, __READ_RESULT = pcall(function()
        return PanelBridgeModule.readJSON("state.json")
      end)
    `);

    expect(bridge.getGlobal('__READ_OK')).toBe(true);
    expect(bridge.getGlobal('__READ_RESULT')).toBeNull();
  });
});
