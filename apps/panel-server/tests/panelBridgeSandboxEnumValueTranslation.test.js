import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, regression, item 4 -- panelbridge-regression-2026-08-30.
// getAllSandboxOptions' enum-values block gated on `opt.getNumValues and
// opt.getValueName` (a field-test on a Java object -- the same anti-pattern
// this file bans elsewhere) and called opt:getValueName(i), a method that
// does not exist anywhere in the real jar's SandboxOption/ConfigOption
// hierarchy (confirmed by parsing EnumSandboxOption/StrongEnumSandboxOption/
// EnumConfigOption/ConfigOption directly). The real method is
// getValueTranslationByIndexOrNull. Every enum sandbox option's enumValues
// came back empty or absent, always, with no error surfaced.

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

// Deliberately does NOT define getValueName -- models the real jar, where it
// genuinely does not exist anywhere in the hierarchy. Only defines the real
// jar-confirmed methods: getClass() (for enum-type detection via its
// tostring() containing "Enum"), getNumValues(), and
// getValueTranslationByIndexOrNull(i).
const STUBS = `
FakeEnumClass = setmetatable({}, { __tostring = function() return "class zombie.SandboxOptions$EnumSandboxOption" end })

FakeEnumOption = { name = "ElecShut", short = "ElecShut", tbl = "Utilities", value = 0 }
function FakeEnumOption:getName() return self.name end
function FakeEnumOption:getShortName() return self.short end
function FakeEnumOption:getTableName() return self.tbl end
function FakeEnumOption:getValue() return self.value end
function FakeEnumOption:getClass() return FakeEnumClass end
function FakeEnumOption:getNumValues() return 3 end
function FakeEnumOption:getValueTranslationByIndexOrNull(i)
  local names = { [0] = "Never", [1] = "Instant", [2] = "Delayed" }
  return names[i]
end

FakeSandbox = {}
function FakeSandbox:getNumOptions() return 1 end
function FakeSandbox:getOptionByIndex(i)
  if i == 0 then return FakeEnumOption end
  return nil
end
getSandboxOptions = function() return FakeSandbox end
getText = function(key) return key end
`;

describe('PanelBridge.lua handlers.getAllSandboxOptions -- enum values via the real jar method, no field-test gate', () => {
  it('populates enumValues from getValueTranslationByIndexOrNull, not the nonexistent getValueName', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler('getAllSandboxOptions', {});

    expect(result.ok).toBe(true);
    const option = result.data.options.Utilities[0];
    expect(option.name).toBe('ElecShut');
    expect(option.enumValues).toEqual(['Never', 'Instant', 'Delayed']);
  });

  it('a partially-missing translation (nil for one index) is skipped, not inserted as the literal string "nil"', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS + `
      function FakeEnumOption:getValueTranslationByIndexOrNull(i)
        local names = { [0] = "Never", [2] = "Delayed" }
        return names[i]
      end
    `);
    const result = bridge.callHandler('getAllSandboxOptions', {});

    expect(result.ok).toBe(true);
    const option = result.data.options.Utilities[0];
    expect(option.enumValues).toEqual(['Never', 'Delayed']);
    expect(option.enumValues).not.toContain('nil');
  });
});
