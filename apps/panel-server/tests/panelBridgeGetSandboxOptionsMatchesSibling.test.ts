import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.ts';


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
FakeOption1 = { name = "ZombieCount", short = "ZombieCount", tbl = "Zombies", value = 4 }
function FakeOption1:getName() return self.name end
function FakeOption1:getShortName() return self.short end
function FakeOption1:getTableName() return self.tbl end
function FakeOption1:getValue() return self.value end

FakeOption2 = { name = "SleepAllowed", short = "SleepAllowed", tbl = "Character", value = true }
function FakeOption2:getName() return self.name end
function FakeOption2:getShortName() return self.short end
function FakeOption2:getTableName() return self.tbl end
function FakeOption2:getValue() return self.value end

FakeSandbox = {}
function FakeSandbox:getNumOptions() return 2 end
function FakeSandbox:getOptionByIndex(i)
  if i == 0 then return FakeOption1 end
  if i == 1 then return FakeOption2 end
  return nil
end
getSandboxOptions = function() return FakeSandbox end
getText = function(key) return key end
`;

describe('PanelBridge.lua handlers.getSandboxOptions -- delegates to getAllSandboxOptions instead of 11 nonexistent getters', () => {
  it('reports real, populated options instead of a silently-empty success', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler('getSandboxOptions', {});

    expect(result.ok).toBe(true);
    expect(result.data.totalCount).toBe(2);
    expect(result.data.options.Zombies).toBeTruthy();
    expect(result.data.options.Zombies[0].name).toBe('ZombieCount');
    expect(result.data.options.Zombies[0].value).toBe(4);
  });

  it('returns the exact same data as getAllSandboxOptions -- a true delegate, not a second implementation to drift out of sync', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const viaSandboxOptions = bridge.callHandler('getSandboxOptions', {});
    const viaAllSandboxOptions = bridge.callHandler('getAllSandboxOptions', {});

    expect(viaSandboxOptions).toEqual(viaAllSandboxOptions);
  });

  it('SandboxOptions unavailable still fails honestly, same as before', () => {
    const bridge = loadPanelBridge(LUA_PATH, 'getSandboxOptions = function() return nil end');
    const result = bridge.callHandler('getSandboxOptions', {});

    expect(result.ok).toBe(false);
    expect(result.err).toBeTruthy();
  });
});
