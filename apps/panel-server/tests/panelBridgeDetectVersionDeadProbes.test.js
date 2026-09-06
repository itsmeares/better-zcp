import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, regression, item 5 (the own foundation-lens
// finding). PanelBridge.detectVersion() gated four flags
// (isB42, isB41, features.blizzard, features.tropical) on
// PanelBridge.hasMethod, whose own doc comment says "Never gate an action
// on this; use invoke instead." Both of hasMethod's branches were dead at
// this call site: the field-test branch is unreliable for a Java-bound
// method (this file's own recurring lesson), and its capability-cache
// fallback is EMPTY BY CONSTRUCTION at this point, since detectVersion
// runs before any handler has ever called PanelBridge.invoke. All four
// flags were permanently false/unset, presented as if a real check ran.
//
// Fix: testPlayer:getTraits() is a safe, side-effect-free getter and IS
// confirmed real B41 API, so it's now confirmed with a real
// PanelBridge.invoke() call. desc:getTraitList (the old isB42 probe) is
// confirmed ABSENT from B42's real jar elsewhere in this file, so it's
// deleted rather than "fixed" -- it could never have proven B42 either
// way. features.blizzard/tropical are NOT safe to probe by actually
// calling them (both trigger a real weather event), so they're left OUT
// of the response entirely instead of reported as a false "false".

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

    // isB42 must come from the version-string fallback now, never from a
    // player-descriptor probe -- with no getCore() defined and getTraits()
    // genuinely absent, neither isB42 nor isB41 should be set.
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
