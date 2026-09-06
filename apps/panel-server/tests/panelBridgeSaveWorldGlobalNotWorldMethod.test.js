import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';


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
