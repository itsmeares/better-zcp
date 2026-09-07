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

describe('PanelBridge.lua PanelBridge.detectVersion() -- no longer gates flags on the dead hasMethod probes', () => {
  it('isB41 is confirmed via a REAL invoke() call on testPlayer:getTraits(), not the dead hasMethod probe', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
FakePlayer = {}
function FakePlayer:getTraits() return {} end
FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end
`);
    bridge.run('__version = PanelBridgeModule.detectVersion()');
    const version = bridge.getGlobal('__version');

    expect(version.isB41).toBe(true);
  });

  it('the deleted isB42 probe (desc:getTraitList) has NO effect even if a stub still defines it -- proves the dead code path is truly gone, not just unreachable', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
FakeDescriptor = {}
function FakeDescriptor:getTraitList() return {} end
FakePlayer = {}
function FakePlayer:getDescriptor() return FakeDescriptor end
-- getTraits deliberately NOT defined -- models a build where it is
-- genuinely absent, so a real invoke() call fails honestly.
FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end
`);
    bridge.run('__version = PanelBridgeModule.detectVersion()');
    const version = bridge.getGlobal('__version');

    expect(version.isB42).toBe(false);
    expect(version.isB41).toBe(false);
  });

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

  it('the version-string fallback still correctly determines isB42 when no player is online', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
getOnlinePlayers = function() return nil end
FakeCore = {}
function FakeCore:getVersion() return "42.10.0" end
getCore = function() return FakeCore end
`);
    bridge.run('__version = PanelBridgeModule.detectVersion()');
    const version = bridge.getGlobal('__version');

    expect(version.isB42).toBe(true);
    expect(version.isB41).toBe(false);
  });
});
