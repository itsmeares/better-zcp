import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, total-audit follow-up: collectVehicles() (see
// panelBridgeVehicleCollectionRuntimeShape.test.js) has three call sites.
// getVehiclesDetailed and removeVehiclesInArea both capture (list, err), but
// findVehicleById used to capture only `list`, discarding the error
// collectVehicles wrote specifically to be surfaced. findVehicleById then
// did `if not list then return nil end`, so the caller could never tell
// "the vehicle list itself is unreadable" apart from "no vehicle has this
// id" -- both looked identical: a bare nil.
//
// findVehicleById is the lookup behind 8 per-vehicle handlers (removeVehicle,
// vehicleRepair, vehicleHotwire, vehicleSetFuel, vehicleSetBattery,
// vehicleSetSiren, vehicleSetAlarm, vehicleSetTrunkLocked). Every one of
// them used to report the same generic "Vehicle not found" regardless of
// which of the two real causes was true -- sending an admin hunting a
// vehicle-id problem that did not exist, when the actual cause was the
// collection-unreadable case getVehiclesDetailed already reports honestly.
//
// This file exercises TWO of the 8 (removeVehicle and vehicleRepair) as
// representative siblings, not all 8 -- the fix is in the one shared
// function they all call, so testing the propagation once per call SHAPE
// (immediate lookup vs. lookup-then-further-action) is enough to prove the
// class is fixed without duplicating the same assertion 8 times.

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

function worldStub(cellDecl) {
  return `
${cellDecl}
FakeWorld = {}
function FakeWorld:getCell() return FakeCell end
getWorld = function() return FakeWorld end
`;
}

describe('PanelBridge.lua findVehicleById -- propagates collectVehicles\' real error instead of collapsing it to "not found"', () => {
  it('removeVehicle: unreadable vehicle collection reports the REAL reason, not "Vehicle not found"', () => {
    const cell = `
FakeCell = {}
FakeVehicleBroken = {}
function FakeVehicleBroken:size() return 2 end
-- No get(), no iterator() -- the collection genuinely cannot be read.
function FakeCell:getVehicles() return FakeVehicleBroken end
`;
    const bridge = loadPanelBridge(LUA_PATH, worldStub(cell));
    const result = bridge.callHandler('removeVehicle', { vehicleId: 1 });

    expect(result.ok).toBe(false);
    expect(result.err).not.toMatch(/^Vehicle not found$/);
    expect(result.err).toMatch(/2 vehicle\(s\)/);
    expect(result.err).toMatch(/neither get\(i\) nor iterator\(\)/);
  });

  it('vehicleRepair: unreadable vehicle collection reports the REAL reason, not "Vehicle not found"', () => {
    const cell = `
FakeCell = {}
FakeVehicleBroken = {}
function FakeVehicleBroken:size() return 3 end
function FakeCell:getVehicles() return FakeVehicleBroken end
`;
    const bridge = loadPanelBridge(LUA_PATH, worldStub(cell));
    const result = bridge.callHandler('vehicleRepair', { vehicleId: 1 });

    expect(result.ok).toBe(false);
    expect(result.err).not.toMatch(/^Vehicle not found$/);
    expect(result.err).toMatch(/3 vehicle\(s\)/);
  });

  it('removeVehicle: a genuinely nonexistent id on a READABLE list still reports plain "Vehicle not found" -- the distinction is preserved, not just always replaced', () => {
    const cell = `
FakeCell = {}
FakeVehicle1 = { id = 1 }
function FakeVehicle1:getId() return self.id end
FakeVehicleList = { FakeVehicle1 }
function FakeVehicleList:size() return 1 end
function FakeVehicleList:get(i) return self[i + 1] end
function FakeCell:getVehicles() return FakeVehicleList end
`;
    const bridge = loadPanelBridge(LUA_PATH, worldStub(cell));
    const result = bridge.callHandler('removeVehicle', { vehicleId: 999 });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/Vehicle not found/);
    expect(result.err).toMatch(/999/);
  });

  it('removeVehicle: no vehicles at all on the server (genuine empty list) is still "Vehicle not found", not confused with the unreadable case', () => {
    const cell = `
FakeCell = {}
FakeVehicleEmpty = {}
function FakeVehicleEmpty:size() return 0 end
function FakeVehicleEmpty:get(i) return nil end
function FakeCell:getVehicles() return FakeVehicleEmpty end
`;
    const bridge = loadPanelBridge(LUA_PATH, worldStub(cell));
    const result = bridge.callHandler('removeVehicle', { vehicleId: 1 });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/Vehicle not found/);
  });
});
