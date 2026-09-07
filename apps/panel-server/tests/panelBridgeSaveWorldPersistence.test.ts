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

    expect(result.ok).toBe(true);
    expect(result.data.persisted).toBe(false);
    expect(typeof result.data.saveError).toBe('string');
    expect(result.data.saveError).toContain('disk full');
  });
});
