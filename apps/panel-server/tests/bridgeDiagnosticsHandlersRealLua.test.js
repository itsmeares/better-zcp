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

function luaJavaList(varName, itemsLuaLiteral) {
  return `
local ${varName}_items = ${itemsLuaLiteral}
${varName} = {
  size = function(self) return #${varName}_items end,
  get = function(self, i) return ${varName}_items[i + 1] end,
}
`;
}

describe('bridge.diagnostics Lua handlers -- do something real if called (real Lua source under fengari)', () => {
  it('getDebugLog: filters real seeded entries by minLevel, does not just echo everything', () => {
    const bridge = loadPanelBridge(LUA_PATH);
    bridge.run(`
      PanelBridgeModule.debugLog = {
        { level = "DEBUG", message = "d1" },
        { level = "WARN", message = "w1" },
        { level = "ERROR", message = "e1" },
      }
    `);

    const allLevels = bridge.callHandler('getDebugLog', { limit: 10, minLevel: 'DEBUG' });
    expect(allLevels.ok).toBe(true);
    expect(allLevels.data.entries.length).toBe(3);
    expect(allLevels.data.totalEntries).toBe(3);

    const warnAndUp = bridge.callHandler('getDebugLog', { limit: 10, minLevel: 'WARN' });
    expect(warnAndUp.data.entries.map((e) => e.message)).toEqual(['w1', 'e1']);
  });

  it('setDebugMode: real state mutation, gated on strict boolean true (not truthy coercion)', () => {
    const bridge = loadPanelBridge(LUA_PATH);

    const on = bridge.callHandler('setDebugMode', { enabled: true });
    expect(on.ok).toBe(true);
    expect(on.data.debugMode).toBe(true);
    bridge.run('__DM_ON = PanelBridgeModule.DEBUG_MODE');
    expect(bridge.getGlobal('__DM_ON')).toBe(true);

    const stringTrue = bridge.callHandler('setDebugMode', { enabled: 'true' });
    expect(stringTrue.data.debugMode).toBe(false);
    bridge.run('__DM_STR = PanelBridgeModule.DEBUG_MODE');
    expect(bridge.getGlobal('__DM_STR')).toBe(false);
  });

  it('getStats: reports real seeded counters and a genuinely computed uptime, not a stub', () => {
    const bridge = loadPanelBridge(LUA_PATH, 'getTimestampMs = function() return 4000 end');
    bridge.run(`
      PanelBridgeModule.stats.startTime = 1000
      PanelBridgeModule.stats.commandsProcessed = 5
      PanelBridgeModule.stats.commandsSucceeded = 3
      PanelBridgeModule.stats.commandsFailed = 2
      PanelBridgeModule.stats.lastError = "boom"
    `);

    const result = bridge.callHandler('getStats', {});
    expect(result.ok).toBe(true);
    expect(result.data.commandsProcessed).toBe(5);
    expect(result.data.commandsSucceeded).toBe(3);
    expect(result.data.commandsFailed).toBe(2);
    expect(result.data.lastError).toBe('boom');
    expect(result.data.uptime).toBe(3);
  });

  it('checkAPI: reports real availability for a present object, and honestly reports absence for one that is not (negative control)', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
      ClimateStub = { setEnableAdmin = function() end }
      getClimateManager = function() return ClimateStub end
    `);

    const present = bridge.callHandler('checkAPI', { object: 'ClimateManager', method: 'setEnableAdmin' });
    expect(present.ok).toBe(true);
    expect(present.data.available).toBe(true);
    expect(present.data.methodAvailable).toBe(true);

    const missingMethod = bridge.callHandler('checkAPI', { object: 'ClimateManager', method: 'noSuchMethod' });
    expect(missingMethod.data.methodAvailable).toBe(false);

    const absent = bridge.callHandler('checkAPI', { object: 'GameTime' });
    expect(absent.data.available).toBe(false);
  });

  it('getAvailableHandlers: introspects the REAL handlers table (includes a handler defined thousands of lines away), not a hardcoded list', () => {
    const bridge = loadPanelBridge(LUA_PATH);
    const result = bridge.callHandler('getAvailableHandlers', {});

    expect(result.ok).toBe(true);
    expect(result.data.handlers).toEqual(expect.arrayContaining([
      'getDebugLog', 'setDayLight', 'moderationBanUser', 'getVehicleCatalog',
    ]));
    expect(result.data.count).toBe(result.data.handlers.length);
  });

  it('clearErrors: really empties the error log (not just a message claiming it did)', () => {
    const bridge = loadPanelBridge(LUA_PATH);
    bridge.run(`
      PanelBridgeModule.stats.errors = { "e1", "e2", "e3" }
      PanelBridgeModule.stats.lastError = "e3"
    `);

    const result = bridge.callHandler('clearErrors', {});
    expect(result.ok).toBe(true);
    expect(result.data.message).toBe('Cleared 3 errors');

    bridge.run('__ERR_COUNT = #PanelBridgeModule.stats.errors');
    expect(bridge.getGlobal('__ERR_COUNT')).toBe(0);
    bridge.run('__LAST_ERR = PanelBridgeModule.stats.lastError');
    expect(bridge.getGlobal('__LAST_ERR')).toBe(null);
  });

  it('debugItemScript: probes a real item script for its category API, and honestly fails without ScriptManager (negative control)', () => {
    const noScriptManager = loadPanelBridge(LUA_PATH);
    const failResult = noScriptManager.callHandler('debugItemScript', {});
    expect(failResult.ok).toBe(false);
    expect(failResult.err).toBe('ScriptManager not available');

    const withItems = loadPanelBridge(LUA_PATH, `
      ${luaJavaList('__ITEMS', '{ { getFullName = function() return "Base.Hammer" end, getTypeString = function() return "Weapon" end } }')}
      ScriptManager = { instance = { getAllItems = function() return __ITEMS end } }
    `);
    const result = withItems.callHandler('debugItemScript', {});
    expect(result.ok).toBe(true);
    expect(result.data.probes[0].id).toBe('Base.Hammer');
    expect(result.data.probes[0].getTypeString).toBe('Weapon');
  });

  it('getItemCatalog: builds a real catalog from a real item script, and honestly fails without ScriptManager (negative control)', () => {
    const noScriptManager = loadPanelBridge(LUA_PATH);
    const failResult = noScriptManager.callHandler('getItemCatalog', {});
    expect(failResult.ok).toBe(false);
    expect(failResult.err).toBe('ScriptManager not available');

    const withItems = loadPanelBridge(LUA_PATH, `
      ${luaJavaList('__ITEMS', `{
        {
          getFullName = function() return "Base.Hammer" end,
          getDisplayName = function() return "Hammer" end,
          getDisplayCategory = function() return "Tool" end,
          getActualWeight = function() return 1.5 end,
        },
      }`)}
      ScriptManager = { instance = { getAllItems = function() return __ITEMS end } }
    `);
    const result = withItems.callHandler('getItemCatalog', {});
    expect(result.ok).toBe(true);
    expect(result.data.count).toBe(1);
    expect(result.data.items[0]).toEqual({
      id: 'Base.Hammer',
      name: 'Hammer',
      category: 'Tool',
      weight: 1.5,
    });
  });

  it('getVehicleCatalog: builds a real catalog from a real vehicle script via the B42 method, and honestly fails when neither B42 nor B41 method exists (negative control)', () => {
    const neitherMethod = loadPanelBridge(LUA_PATH, `
      ScriptManager = { instance = {} }
    `);
    const failResult = neitherMethod.callHandler('getVehicleCatalog', {});
    expect(failResult.ok).toBe(false);
    expect(failResult.err).toBe('Failed to enumerate vehicles: API not available');

    const withVehicles = loadPanelBridge(LUA_PATH, `
      ${luaJavaList('__VEHICLES', `{
        {
          getFullName = function() return "Base.PickUpTruck" end,
          getName = function() return "PickUpTruck" end,
          getMass = function() return 1500 end,
          getPassengerCount = function(self) return 4 end,
        },
      }`)}
      ScriptManager = { instance = { getAllVehicleScripts = function() return __VEHICLES end } }
    `);
    const result = withVehicles.callHandler('getVehicleCatalog', {});
    expect(result.ok).toBe(true);
    expect(result.data.count).toBe(1);
    expect(result.data.vehicles[0]).toEqual({
      id: 'Base.PickUpTruck',
      name: 'PickUpTruck',
      mass: 1500,
      seats: 4,
    });
  });
});
