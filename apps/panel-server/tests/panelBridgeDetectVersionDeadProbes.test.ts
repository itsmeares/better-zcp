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

describe('PanelBridge.lua PanelBridge.detectVersion()', () => {
  it('features.blizzard/tropical are OMITTED from the response, never reported as a false "false"', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
FakeClimate = {}
function FakeClimate:transmitTriggerBlizzard(duration) end
function FakeClimate:transmitTriggerTropical(duration) end
getClimateManager = function() return FakeClimate end
`);
    bridge.run('__version = PanelBridgeModule.detectVersion()');
    const version = bridge.getGlobal('__version');

    expect('blizzard' in version.features).toBe(false);
    expect('tropical' in version.features).toBe(false);
  });

  it('determines Build 42 from the game version string', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
getOnlinePlayers = function() return nil end
FakeCore = {}
function FakeCore:getVersion() return "42.10.0" end
getCore = function() return FakeCore end
`);
    bridge.run('__version = PanelBridgeModule.detectVersion()');
    const version = bridge.getGlobal('__version');

    expect(version.isB42).toBe(true);
  });

  it('does not classify an older build as supported', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
FakeCore = {}
function FakeCore:getVersion() return "40.0.0" end
getCore = function() return FakeCore end
`);
    bridge.run('__version = PanelBridgeModule.detectVersion()');
    const version = bridge.getGlobal('__version');

    expect(version.isB42).toBe(false);
  });
});
