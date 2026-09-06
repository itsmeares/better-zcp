import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, operator: "Fix event." handlers.triggerHelicopterEvent used
// to try four fallback tiers -- HelicopterClass.getInstance()+
// activateForPlayer, RZSUtil.triggerRandomEvent, addHelicopter,
// ServerCheatInterface.triggerHelicopter -- ALL FOUR verified absent
// against the real B42 jar (the audit): not a B41/B42 divergence, not
// a near-miss name, none of them exist on any build. It always fell
// through to error("No helicopter API available in this build").
//
// The one real API is LuaManager$GlobalObject.testHelicopter() -- same
// bare-global binding tier as getWorld()/getCell()/saveGame() -- and it is
// ZERO-ARG, so there is no per-player targeting API anywhere in the
// confirmed jar. The handler no longer accepts a username at all: silently
// accepting an argument it cannot honour is the same defect class as
// everything else fixed in this audit, so passing one is now a clear,
// named error instead of being ignored.

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

describe('PanelBridge.lua handlers.triggerHelicopterEvent -- uses the real zero-arg testHelicopter(), not the four fabricated fallback tiers', () => {
  it('with no username, calls the real testHelicopter() global and succeeds -- a username is NO LONGER required', () => {
    const bridge = loadPanelBridge(LUA_PATH, 'testHelicopter = function() end');
    const result = bridge.callHandler('triggerHelicopterEvent', {});

    expect(result.ok).toBe(true);
  });

  it('a username argument is refused with a clear, specific reason instead of being silently ignored or chasing a fabricated per-player API', () => {
    const bridge = loadPanelBridge(LUA_PATH, 'testHelicopter = function() end');
    const result = bridge.callHandler('triggerHelicopterEvent', { username: 'Alice' });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/cannot target a specific player/i);
    expect(result.err).toMatch(/testHelicopter/);
  });

  it('testHelicopter() throwing is a real, named failure', () => {
    const bridge = loadPanelBridge(LUA_PATH, 'testHelicopter = function() error("simulated engine failure") end');
    const result = bridge.callHandler('triggerHelicopterEvent', {});

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/simulated engine failure/);
  });

  it('succeeds with NONE of the four old fabricated globals defined -- proves the fix no longer depends on any of them', () => {
    // Deliberately does not define HelicopterClass/RZSUtil/addHelicopter/
    // ServerCheatInterface at all -- models the real jar, where none of
    // them exist. Only testHelicopter is defined, matching what the real
    // jar actually provides.
    const bridge = loadPanelBridge(LUA_PATH, 'testHelicopter = function() end');
    const result = bridge.callHandler('triggerHelicopterEvent', {});

    expect(result.ok).toBe(true);
  });

  it('testHelicopter() not existing at all reports a real failure, not a silent success', () => {
    const bridge = loadPanelBridge(LUA_PATH, '');
    const result = bridge.callHandler('triggerHelicopterEvent', {});

    expect(result.ok).toBe(false);
    expect(typeof result.err).toBe('string');
    expect(result.err.length).toBeGreaterThan(0);
  });
});
