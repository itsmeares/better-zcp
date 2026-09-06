import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// Regression coverage for b376b2c: handlers.setSandboxOption used to wrap
// world:saveWorld() in a bare pcall, discard the result, and unconditionally
// report success -- so a failed disk write was indistinguishable from a
// successful one to anything reading the handler's response. See this
// harness's HONEST LIMIT note in helpers/panelBridgeLua.js: these fakes
// encode our belief about getSandboxOptions/getWorld's shape, not a verified
// PZ truth.
//
// UPDATED 2026-08-30 (total-audit batch 1, item 2, Kevin's jar-verified
// spec): world:saveWorld() does not exist anywhere in the jar -- the real
// save call is saveGame(), a bare global (same LuaManager$GlobalObject
// binding tier as getWorld()/getCell()), zero args, void return. The old
// `world.saveWorld` field-existence guard this handler used was always
// false regardless of world's real state, so this whole persistence path
// could never actually run before -- these stubs now model the REAL API
// (a bare saveGame() global) instead of the belief that broke it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',  'integrations', 'panelbridge',
  'PanelBridge',
  'media',
  'lua',
  'server',
  'PanelBridge.lua',
);

const STUBS = `
FakeOption = { name = "ZombieCount", value = 4 }
FakeOption.__index = FakeOption
function FakeOption:getName() return self.name end
function FakeOption:getClass() return "class zombie.SandboxOptions$IntegerSandboxOption" end
function FakeOption:getValue() return self.value end
function FakeOption:setValue(v) self.value = v end
setmetatable(FakeOption, FakeOption)

FakeSandbox = {}
FakeSandbox.__index = FakeSandbox
function FakeSandbox:getNumOptions() return 1 end
function FakeSandbox:getOptionByIndex(i) if i == 0 then return FakeOption end return nil end
getSandboxOptions = function() return setmetatable({}, FakeSandbox) end

FakeWorld = {}
getWorld = function() return FakeWorld end

FakeSaveGameShouldFail = false
saveGame = function()
  if FakeSaveGameShouldFail then error("disk full (fake)") end
end
`;

describe('PanelBridge.lua handlers.setSandboxOption -- world save persistence (b376b2c)', () => {
  it('reports persisted=true and no saveError when saveGame() succeeds', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run('FakeSaveGameShouldFail = false');

    const result = bridge.callHandler('setSandboxOption', { name: 'ZombieCount', value: '8' });

    expect(result.ok).toBe(true);
    expect(result.data.persisted).toBe(true);
    expect(result.data.saveError == null).toBe(true);
  });

  it('reports persisted=false with the real failure reason when saveGame() throws -- must NOT report silent success', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run('FakeSaveGameShouldFail = true');

    const result = bridge.callHandler('setSandboxOption', { name: 'ZombieCount', value: '9' });

    // The in-memory option write itself genuinely succeeded (setValue ran
    // before the save was attempted), so ok stays true -- what must not
    // happen is claiming the change is durable when the disk write failed.
    expect(result.ok).toBe(true);
    expect(result.data.persisted).toBe(false);
    expect(typeof result.data.saveError).toBe('string');
    expect(result.data.saveError).toContain('disk full');
  });
});
