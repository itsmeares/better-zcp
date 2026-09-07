import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { lua, to_luastring } from 'fengari';
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

describe('PanelBridge.lua capabilityKey -- does not build a value-derived key from an overridden toString', () => {
  it('does not index getClass on a Java userdata wrapper', () => {
    const bridge = loadPanelBridge(LUA_PATH, '');
    lua.lua_newuserdata(bridge.L, 0);
    lua.lua_setglobal(bridge.L, to_luastring('__probe'));

    bridge.run(`
      local getClassReads = 0
      local methodReads = 0
      debug.setmetatable(__probe, {
        __index = function(_, key)
          if key == "getClass" then
            getClassReads = getClassReads + 1
          else
            methodReads = methodReads + 1
          end
          return function() return "ok" end
        end,
      })
      __probeOk = PanelBridgeModule.invoke(__probe, "someMethod")
      __probeGetClassReads = getClassReads
      __probeMethodReads = methodReads
    `);

    expect(bridge.getGlobal('__probeOk')).toBe(true);
    expect(bridge.getGlobal('__probeGetClassReads')).toBe(0);
    expect(bridge.getGlobal('__probeMethodReads')).toBe(1);
  });

  it('checks userdata methods without indexing or invoking the receiver', () => {
    const bridge = loadPanelBridge(LUA_PATH, '');
    lua.lua_newuserdata(bridge.L, 0);
    lua.lua_setglobal(bridge.L, to_luastring('__probe'));

    bridge.run(`
      local invoked = 0
      debug.setmetatable(__probe, {
        __index = function(_, key)
          invoked = invoked + 1
          return function() invoked = invoked + 100 end
        end,
      })
      __probeHasMethod = PanelBridgeModule.hasMethod(__probe, "missingMethod")
      __probeInvocationCount = invoked
    `);

    expect(bridge.getGlobal('__probeHasMethod')).toBe(false);
    expect(bridge.getGlobal('__probeInvocationCount')).toBe(0);
  });

  it('an object with NO getClass() and an overridden toString (no @hex) never poisons the cache for a DIFFERENT object sharing that same toString text', () => {
    const bridge = loadPanelBridge(LUA_PATH, '');

    bridge.run(`
      -- Models an object whose toString is overridden to return a plain
      -- value (e.g. IsoPlayer returning a username) -- no getClass(), no
      -- @hex in tostring().
      FakeBroken = setmetatable({}, { __tostring = function() return "Alice" end })
      -- getHunger deliberately does not exist -- every call fails the same
      -- way Build 42 fails a genuinely missing method.

      -- A DIFFERENT object that happens to share the exact same toString
      -- text (the actual failure mode: two distinct game objects whose
      -- override produces identical text), but whose getHunger genuinely
      -- works.
      FakeWorking = setmetatable({ hunger = 0.5 }, { __tostring = function() return "Alice" end })
      function FakeWorking:getHunger() return self.hunger end
    `);

    for (let i = 0; i < 4; i++) {
      bridge.run(`__ok, __result = PanelBridgeModule.invoke(FakeBroken, "getHunger")`);
    }
    const brokenResult = bridge.getGlobal('__ok');
    expect(brokenResult).toBe(false);

    bridge.run(`__ok2, __result2 = PanelBridgeModule.invoke(FakeWorking, "getHunger")`);
    const workingOk = bridge.getGlobal('__ok2');
    const workingResult = bridge.getGlobal('__result2');

    expect(workingOk).toBe(true);
    expect(workingResult).toBe(0.5);
  });

  it('no cache key is ever recorded for an overridden-toString object with no @hex to strip', () => {
    const bridge = loadPanelBridge(LUA_PATH, '');

    bridge.run(`
      FakeBroken = setmetatable({}, { __tostring = function() return "Alice" end })
    `);
    for (let i = 0; i < 4; i++) {
      bridge.run(`PanelBridgeModule.invoke(FakeBroken, "getHunger")`);
    }

    bridge.run(`
      __capKeys = {}
      for k in pairs(PanelBridgeModule.methodCapabilities) do table.insert(__capKeys, k) end
      __failKeys = {}
      for k in pairs(PanelBridgeModule.methodFailures) do table.insert(__failKeys, k) end
    `);
    const capKeys = bridge.getGlobal('__capKeys');
    const failKeys = bridge.getGlobal('__failKeys');
    const keys = [
      ...(Array.isArray(capKeys) ? capKeys : Object.values(capKeys || {})),
      ...(Array.isArray(failKeys) ? failKeys : Object.values(failKeys || {})),
    ];

    expect(keys.some((k) => k.includes('Alice'))).toBe(false);
  });

  it('an object whose toString DOES contain a real @hex identity suffix is unaffected -- still gets a class-derived key and still caches correctly', () => {
    const bridge = loadPanelBridge(LUA_PATH, '');

    bridge.run(`
      FakeJavaDefault = setmetatable({}, {
        __tostring = function() return "zombie.characters.IsoPlayer@1a2b3c4d" end
      })
    `);
    for (let i = 0; i < 4; i++) {
      bridge.run(`__ok3, __result3 = PanelBridgeModule.invoke(FakeJavaDefault, "someMissingMethod")`);
    }
    expect(bridge.getGlobal('__ok3')).toBe(false);

    bridge.run(`
      __capKeys3 = {}
      for k in pairs(PanelBridgeModule.methodCapabilities) do table.insert(__capKeys3, k) end
    `);
    const capKeys3 = bridge.getGlobal('__capKeys3');
    const keys = Array.isArray(capKeys3) ? capKeys3 : Object.values(capKeys3 || {});
    expect(keys.some((k) => k.includes('zombie.characters.IsoPlayer') && k.includes('someMissingMethod'))).toBe(true);
    expect(keys.some((k) => k.includes('@'))).toBe(false);
  });
});
