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
