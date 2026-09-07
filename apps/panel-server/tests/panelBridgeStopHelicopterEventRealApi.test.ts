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

describe('PanelBridge.lua handlers.stopHelicopterEvent -- the real zero-arg endHelicopter() global', () => {
  it('with no username, calls the real endHelicopter() global and succeeds', () => {
    const bridge = loadPanelBridge(LUA_PATH, 'endHelicopter = function() end');
    const result = bridge.callHandler('stopHelicopterEvent', {});

    expect(result.ok).toBe(true);
  });

  it('a username argument is refused with a clear, specific reason instead of being silently ignored or implying a per-player stop exists', () => {
    const bridge = loadPanelBridge(LUA_PATH, 'endHelicopter = function() end');
    const result = bridge.callHandler('stopHelicopterEvent', { username: 'Alice' });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/cannot target a specific player/i);
    expect(result.err).toMatch(/endHelicopter/);
  });

  it('endHelicopter() throwing is a real, named failure', () => {
    const bridge = loadPanelBridge(LUA_PATH, 'endHelicopter = function() error("simulated engine failure") end');
    const result = bridge.callHandler('stopHelicopterEvent', {});

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/simulated engine failure/);
  });

  it('endHelicopter() not existing at all reports a real failure, not a silent success', () => {
    const bridge = loadPanelBridge(LUA_PATH, '');
    const result = bridge.callHandler('stopHelicopterEvent', {});

    expect(result.ok).toBe(false);
    expect(typeof result.err).toBe('string');
    expect(result.err.length).toBeGreaterThan(0);
  });

  it('is independent of testHelicopter() -- stopping does not require the trigger global to also be defined', () => {
    // global (e.g. a copy-paste of the wrong function name).
    const bridge = loadPanelBridge(LUA_PATH, 'endHelicopter = function() end');
    const result = bridge.callHandler('stopHelicopterEvent', {});

    expect(result.ok).toBe(true);
  });
});
