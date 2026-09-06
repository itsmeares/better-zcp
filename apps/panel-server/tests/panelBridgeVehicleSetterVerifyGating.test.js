import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// Regression coverage found while building the general verify/gate helper
// and its enforcement test: vehicleSetAlarm/SetSiren/SetTrunkLocked/SetFuel/
// SetBattery were listed in the original 96-handler audit as "pcall-checked
// at the call-didn't-throw ceiling, no cheap read-back exists" -- but
// handlers.getVehiclesDetailed was already reading isAlarmed/
// getLightbarSirenMode/isTrunkLocked/getRemainingFuelPercentage/
// getBatteryCharge for its own listing. Same shape as the safehouse/faction
// discovery: the read-back existed all along, just never reused to verify
// a mutation.
//
// CORRECTED 2026-08-30 (panelbridge-audit): the siren half of that claim was
// itself wrong, undetected until Kevin's real-jar audit -- getLightbarSirenMode
// does not exist anywhere on BaseVehicle in the real B42 jar (confirmed by
// two independent classfile scans); getLightbarSirenModeObject() is the real
// accessor, returning a LightbarSirenMode wrapper whose own get():int is the
// primitive this code wants. Both PanelBridge.lua (getVehiclesDetailed's
// `sirening` field and vehicleSetSiren's own verify step) and FakeVehicle
// below are updated to the real two-hop shape -- this is why this file's
// siren stub no longer defines getLightbarSirenMode at all; a stub for a
// method the real game doesn't have would just reintroduce the same false
// assumption this correction exists to close.
//
// CORRECTED AGAIN 2026-08-30 (bridge-vehicle-parts-wrong-receiver, same night):
// getPartById/getBattery/getBatteryCharge moved to a separate FakeVehicleParts
// table (see below) since they live on VehicleParts, not the vehicle -- and a
// THIRD instance of this file's own pattern (a stub built from what the code
// believed rather than what the jar declares) surfaced while checking for it:
// Kevin's Pass 2 audit already found setRemainingFuelPercentage absent from
// the entire B42 vehicle API too, dead-but-harmless only because the real
// GasTank-container path (routed through getPartById, now fixed) works. This
// stub's old FakeVehicleParts.getPartById returned nil unconditionally, so
// "vehicleSetFuel reports verified=true" only ever exercised the DEAD
// fallback -- a scenario that cannot happen on a real B42 server -- and never
// once touched the real primary path. FakeGasTank below fixes that: the
// success case now goes through getContainerCapacity/setContainerContentAmount
// like the genuine B42 write does, and getRemainingFuelPercentage reads back
// its actual state instead of an independent field, so a real regression in
// the primary path would show up here.

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

function vehicleStub({ sticks = true, alarmed = false, sirenMode = 0, trunkLocked = false, fuelPct = 50, batteryCharge = 50 } = {}) {
  return `
FakeVehicle = {
  id = 1,
  alarmed = ${alarmed},
  sirenMode = ${sirenMode},
  trunkLocked = ${trunkLocked},
  fuelPct = ${fuelPct},
  batteryCharge = ${batteryCharge},
  sticks = ${sticks},
}
function FakeVehicle:getId() return self.id end
function FakeVehicle:setAlarmed(v) if self.sticks then self.alarmed = v end end
function FakeVehicle:isAlarmed() return self.alarmed end
function FakeVehicle:triggerAlarm() end
function FakeVehicle:setLightbarSirenMode(v) if self.sticks then self.sirenMode = v end end
function FakeVehicle:getLightbarSirenModeObject()
  local vehicle = self
  local modeObj = {}
  function modeObj:get() return vehicle.sirenMode end
  return modeObj
end
function FakeVehicle:setTrunkLocked(v) if self.sticks then self.trunkLocked = v end end
function FakeVehicle:isTrunkLocked() return self.trunkLocked end
-- setRemainingFuelPercentage does not exist anywhere in the real B42 vehicle
-- API (Kevin's Pass 2 jar audit) -- kept here only because
-- handlers.vehicleSetFuel still attempts it as a B41 fallback when the
-- GasTank path is unavailable; this stub models the (unrealistic) case where
-- it happens to work, same as it always implicitly did before that finding.
-- The real, working path is FakeGasTank below -- getRemainingFuelPercentage
-- reads FakeGasTank's actual state, not this field, so a test relying on
-- this fallback alone would fail to prove anything real.
function FakeVehicle:setRemainingFuelPercentage(v) if self.sticks then self.fuelPct = v end end
function FakeVehicle:getRemainingFuelPercentage() return (FakeGasTank.amount / FakeGasTank.capacity) * 100 end
-- setBatteryCharge does not exist anywhere in the real B42 vehicle API
-- (2026-08-30 jar audit) -- kept here only because handlers.vehicleSetBattery
-- still attempts it as a last-ditch call before giving an honest error; this
-- stub models the (unrealistic) case where it happens to work, same as it
-- always implicitly did before that finding.
function FakeVehicle:setBatteryCharge(v) if self.sticks then self.batteryCharge = v end end

-- getPartById/getBattery/getBatteryCharge live on VehicleParts, reached only
-- via vehicle:getParts() -- NOT on the vehicle object itself. getBatteryCharge
-- reads back FakeVehicle.batteryCharge directly since setBatteryCharge (the
-- only thing that can change it in this stub) still writes there.
-- FakeGasTank models the real B42 fuel path (container capacity/content
-- amount) so vehicleSetFuel's success case exercises the actual working
-- mechanism instead of the dead setRemainingFuelPercentage fallback.
FakeGasTank = {
  capacity = 60,
  amount = ${fuelPct} / 100 * 60,
}
function FakeGasTank:getContainerCapacity() return self.capacity end
function FakeGasTank:setContainerContentAmount(v) if FakeVehicle.sticks then self.amount = v end end

FakeVehicleParts = {}
function FakeVehicleParts:getPartById(id)
  if id == "GasTank" then return FakeGasTank end
  return nil
end
function FakeVehicleParts:getBattery() return nil end
function FakeVehicleParts:getBatteryCharge() return FakeVehicle.batteryCharge end
function FakeVehicle:getParts() return FakeVehicleParts end

FakeVehicleList = { FakeVehicle }
function FakeVehicleList:size() return 1 end
function FakeVehicleList:get(i) return self[i + 1] end

FakeCell = {}
function FakeCell:getVehicles() return FakeVehicleList end

FakeWorld = {}
function FakeWorld:getCell() return FakeCell end
getWorld = function() return FakeWorld end
`;
}

describe('PanelBridge.lua vehicle setters -- gate on getVehiclesDetailed\'s own getters', () => {
  it('vehicleSetAlarm reports verified=true when isAlarmed confirms it', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: true }));
    const result = bridge.callHandler('vehicleSetAlarm', { vehicleId: 1, enabled: true });
    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('vehicleSetAlarm must NOT report success when the write silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: false }));
    const result = bridge.callHandler('vehicleSetAlarm', { vehicleId: 1, enabled: true });
    expect(result.ok).toBe(false);
  });

  it('vehicleSetSiren reports verified=true when getLightbarSirenModeObject().get() confirms it', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: true }));
    const result = bridge.callHandler('vehicleSetSiren', { vehicleId: 1, mode: 2 });
    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('vehicleSetSiren must NOT report success when the write silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: false }));
    const result = bridge.callHandler('vehicleSetSiren', { vehicleId: 1, mode: 2 });
    expect(result.ok).toBe(false);
  });

  it('vehicleSetTrunkLocked reports verified=true when isTrunkLocked confirms it', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: true }));
    const result = bridge.callHandler('vehicleSetTrunkLocked', { vehicleId: 1, locked: true });
    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('vehicleSetTrunkLocked must NOT report success when the write silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: false }));
    const result = bridge.callHandler('vehicleSetTrunkLocked', { vehicleId: 1, locked: true });
    expect(result.ok).toBe(false);
  });

  it('vehicleSetFuel reports verified=true when getRemainingFuelPercentage confirms it (within tolerance)', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: true }));
    const result = bridge.callHandler('vehicleSetFuel', { vehicleId: 1, percent: 80 });
    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('vehicleSetFuel must NOT report success when the write silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: false, fuelPct: 20 }));
    const result = bridge.callHandler('vehicleSetFuel', { vehicleId: 1, percent: 80 });
    expect(result.ok).toBe(false);
  });

  it('vehicleSetBattery reports verified=true when getBatteryCharge confirms it (within tolerance)', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: true }));
    const result = bridge.callHandler('vehicleSetBattery', { vehicleId: 1, charge: 90 });
    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('vehicleSetBattery must NOT report success when the write silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: false, batteryCharge: 10 }));
    const result = bridge.callHandler('vehicleSetBattery', { vehicleId: 1, charge: 90 });
    expect(result.ok).toBe(false);
  });
});
