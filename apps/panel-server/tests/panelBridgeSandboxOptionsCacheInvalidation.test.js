import { describe, expect, it } from 'vitest';
import path from 'path';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, regression, item 3 (the own foundation-lens
// finding). getAllSandboxOptions had a real 300000ms TTL cache entry, but
// was never in the separate LIVE_STATE_CACHE_KEYS list that
// invalidateLiveStateCache() walked -- so a successful setSandboxOption
// write left the panel serving up to 5 minutes of STALE sandbox data. The
// two lists were hand-maintained separately with nothing enforcing that
// they agreed; this is the exact class that already bit
// vehicles/safehouses/players once (see the comment history), surviving
// here because a 6th cacheable action didn't automatically inherit the
// same live/static decision.
//
// Fixed by merging CACHEABLE_TTL_MS and LIVE_STATE_CACHE_KEYS into one
// table (CACHEABLE_ACTIONS) where `live` is a required field per entry --
// getAllSandboxOptions is now `live = true`, so invalidateLiveStateCache()
// clears it along with the other three.
//
// This exercises the REAL dispatcher (PanelBridgeModule.processCommands()),
// not handlers.* directly -- the caching/invalidation logic lives entirely
// in the dispatcher, invisible to a bare handler call. getTimestampMs is
// pinned at 0 by the harness's own base stubs, so TTL expiry never fires on
// its own here -- the only thing that can clear the cache is the
// invalidation path this test is proving.

const LUA_PATH = path.resolve('integrations/panelbridge/PanelBridge/media/lua/server/PanelBridge.lua');

const STUBS = `
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

    // The bug: this used to still return 4 (the cached read1 value) because
    // getAllSandboxOptions was never in the invalidation list.
    expect(byId.read2.success).toBe(true);
    expect(byId.read2.data.options.Vanilla[0].value).toBe(8);
  });

  it('regression guard: the vehicle/safehouse/player trio this class was originally built for still invalidates correctly, unaffected by the merge', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS + `
FakeVehicleCount = { n = 0 }
FakeVehicleList = {}
function FakeVehicleList:size() return FakeVehicleCount.n end
function FakeVehicleList:get(i)
  if i < FakeVehicleCount.n then return {} end
  return nil
end
FakeCell = {}
function FakeCell:getVehicles() return FakeVehicleList end
FakeWorld = {}
function FakeWorld:getCell() return FakeCell end
getWorld = function() return FakeWorld end
`);

    // Round 1: cache the initial (empty) vehicle count.
    enqueue(bridge, [{ id: 'vread1', action: 'getVehiclesDetailed' }], 1);
    bridge.run('PanelBridgeModule.processCommands()');

    // Change the underlying state, then run an unrelated non-cacheable
    // action (setSandboxOption) -- this is what must clear the cached
    // vehicle read, not the vehicle count changing on its own.
    bridge.run('FakeVehicleCount.n = 5');
    enqueue(bridge, [{ id: 'write', action: 'setSandboxOption', args: { name: 'ZombieCount', value: 8 } }], 2);
    bridge.run('PanelBridgeModule.processCommands()');

    enqueue(bridge, [{ id: 'vread2', action: 'getVehiclesDetailed' }], 3);
    bridge.run('PanelBridgeModule.processCommands()');

    const results = bridge.getGlobal('PanelBridgeModule').pendingResults;
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));

    expect(byId.vread1.success).toBe(true);
    expect(byId.vread1.data.count).toBe(0);
    expect(byId.write.success).toBe(true);
    // The bug this class already fixed once: without invalidation, this
    // would still report count=0 (the cached vread1 result).
    expect(byId.vread2.success).toBe(true);
    expect(byId.vread2.data.count).toBe(5);
  });
});
