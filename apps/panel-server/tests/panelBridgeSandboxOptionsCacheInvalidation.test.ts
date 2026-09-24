import { describe, expect, it } from 'vite-plus/test';
import path from 'path';
import { loadPanelBridge } from './helpers/panelBridgeLua.ts';


const LUA_PATH = path.resolve('integrations/panelbridge/PanelBridge/media/lua/server/PanelBridge.lua');

const STUBS = `
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

getText = function(key) return key end
saveGame = function() end

FakeOption = { name = "ZombieCount", value = 4 }
function FakeOption:getName() return self.name end
function FakeOption:getShortName() return self.name end
function FakeOption:getTableName() return "Vanilla" end
function FakeOption:getClass() return "class zombie.SandboxOptions$IntegerSandboxOption" end
function FakeOption:getValue() return self.value end
function FakeOption:setValue(v) self.value = v end

FakeSandbox = {}
function FakeSandbox:getNumOptions() return 1 end
function FakeSandbox:getOptionByIndex(i) if i == 0 then return FakeOption end return nil end
getSandboxOptions = function() return FakeSandbox end
`;

function enqueue(bridge, commands, startSeq) {
  bridge.run(commands.map((cmd, i) => {
    const n = startSeq + i;
    const seq = String(n).padStart(10, '0');
    const json = JSON.stringify({ seq: n, ...cmd });
    return `FILES["panelbridge/TestServer/inbox/cmd-${seq}.json"] = ${JSON.stringify(json)}`;
  }).join('\n'));
}

describe('PanelBridge.lua dispatcher -- setSandboxOption invalidates getAllSandboxOptions\' cache, not just the vehicle/safehouse/player trio', () => {
  it('a value read via getAllSandboxOptions, then changed via setSandboxOption, is NOT served stale on the next getAllSandboxOptions call', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);

    enqueue(bridge, [
      { id: 'read1', action: 'getAllSandboxOptions' },
      { id: 'write', action: 'setSandboxOption', args: { name: 'ZombieCount', value: 8 } },
      { id: 'read2', action: 'getAllSandboxOptions' },
    ], 1);
    bridge.run('PanelBridgeModule.processCommands()');

    const results = bridge.getGlobal('PanelBridgeModule').pendingResults;
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));

    expect(byId.read1.success).toBe(true);
    expect(byId.read1.data.options.Vanilla[0].value).toBe(4);

    expect(byId.write.success).toBe(true);

    expect(byId.read2.success).toBe(true);
    expect(byId.read2.data.options.Vanilla[0].value).toBe(8);
  });

  it('refetches a read-only value after the wall clock moves backward', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);

    bridge.run('NOW = 1000');
    enqueue(bridge, [{ id: 'read1', action: 'getAllSandboxOptions' }], 1);
    bridge.run('PanelBridgeModule.processCommands()');

    bridge.run('FakeOption.value = 8; NOW = 0');
    enqueue(bridge, [{ id: 'read2', action: 'getAllSandboxOptions' }], 2);
    bridge.run('PanelBridgeModule.processCommands()');

    const results = bridge.getGlobal('PanelBridgeModule').pendingResults;
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));

    expect(byId.read1.data.options.Vanilla[0].value).toBe(4);
    expect(byId.read2.data.options.Vanilla[0].value).toBe(8);
  });
});
