import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, regression, item 2 (the jar-verified spec):
// world:saveWorld() does not exist anywhere in the real B42 jar. The real
// save call is saveGame(), a bare global -- same LuaManager$GlobalObject
// binding tier as getWorld()/getCell(), both already called elsewhere in
// this file with identical bare-call syntax -- zero args, void return.
//
// handlers.saveWorld used to gate on `world and world.saveWorld` -- a
// field-existence test that was ALWAYS false regardless of the server's
// real state (world.saveWorld genuinely never exists as a field, the same
// "callable via :method() but reads nil as a field" trap this file warns
// about elsewhere), so this handler could NEVER succeed. This is one of
// TWO live sites for the same bug -- the other is setSandboxOption's persist
// step, covered separately in panelBridgeSaveWorldPersistence.test.js.

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

describe('PanelBridge.lua handlers.saveWorld -- calls the real bare saveGame() global, not a nonexistent world:saveWorld() method', () => {
  it('succeeds when saveGame() is called and does not throw, even though `world` has no saveWorld field at all', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
FakeWorld = {}
getWorld = function() return FakeWorld end
saveGame = function() end
`);
    const result = bridge.callHandler('saveWorld', {});

    expect(result.ok).toBe(true);
  });

  it('reports a real failure reason when saveGame() itself throws', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
FakeWorld = {}
getWorld = function() return FakeWorld end
saveGame = function() error("disk full (fake)") end
`);
    const result = bridge.callHandler('saveWorld', {});

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/disk full/);
  });

  it('regression guard: succeeds even when getWorld() itself returns nil -- saveGame() does not depend on world at all', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
getWorld = function() return nil end
saveGame = function() end
`);
    const result = bridge.callHandler('saveWorld', {});

    expect(result.ok).toBe(true);
  });
});
