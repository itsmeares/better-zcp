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

const BASE_STUBS = `
FakeWorld = {}
function FakeWorld:saveWorld() end
getWorld = function() return FakeWorld end
`;

function integerOptionStub(sticks) {
  return BASE_STUBS + `
FakeOption = { name = "ZombieCount", value = 4, sticks = ${sticks} }
FakeOption.__index = FakeOption
function FakeOption:getName() return self.name end
function FakeOption:getClass() return "class zombie.SandboxOptions$IntegerSandboxOption" end
function FakeOption:getValue() return self.value end
function FakeOption:setValue(v)
  if self.sticks then self.value = v end
end
setmetatable(FakeOption, FakeOption)

FakeSandbox = {}
FakeSandbox.__index = FakeSandbox
function FakeSandbox:getNumOptions() return 1 end
function FakeSandbox:getOptionByIndex(i) if i == 0 then return FakeOption end return nil end
getSandboxOptions = function() return setmetatable({}, FakeSandbox) end
`;
}

const BOOL_TYPE_QUIRK_STUBS = BASE_STUBS + `
-- Simulates an engine option whose getValue() returns the boolean's own
-- string representation ("true"/"false") rather than a native Lua boolean --
-- a legitimate Lua/JSON-boundary quirk, not a failed write.
FakeOption = { name = "SleepAllowed", value = "false" }
FakeOption.__index = FakeOption
function FakeOption:getName() return self.name end
function FakeOption:getClass() return "class zombie.SandboxOptions$BooleanSandboxOption" end
function FakeOption:getValue() return self.value end
function FakeOption:setValue(v) self.value = tostring(v) end
setmetatable(FakeOption, FakeOption)

FakeSandbox = {}
FakeSandbox.__index = FakeSandbox
function FakeSandbox:getNumOptions() return 1 end
function FakeSandbox:getOptionByIndex(i) if i == 0 then return FakeOption end return nil end
getSandboxOptions = function() return setmetatable({}, FakeSandbox) end
`;

describe('PanelBridge.lua handlers.setSandboxOption -- gate ok on verified, comparing meaning not identity', () => {
  it('reports success and verified="confirmed" when the integer write actually sticks', () => {
    const bridge = loadPanelBridge(LUA_PATH, integerOptionStub(true));
    const result = bridge.callHandler('setSandboxOption', { name: 'ZombieCount', value: '8' });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(result.data.value).toBe(8);
  });

  it('must NOT report success when the integer write silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, integerOptionStub(false));
    const result = bridge.callHandler('setSandboxOption', { name: 'ZombieCount', value: '8' });

    expect(result.ok).toBe(false);
  });

  it('treats a boolean read back as its own string representation as a MATCH, not a type-mismatch failure', () => {
    const bridge = loadPanelBridge(LUA_PATH, BOOL_TYPE_QUIRK_STUBS);
    const result = bridge.callHandler('setSandboxOption', { name: 'SleepAllowed', value: true });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });
});
