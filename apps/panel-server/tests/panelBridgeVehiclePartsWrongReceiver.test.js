import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, bridge-vehicle-parts-wrong-receiver (the jar audit):
// getPartCount, getPartByIndex, getPartById, getBattery and getBatteryCharge
// are NOT on zombie.vehicles.BaseVehicle -- they live on a separate class,
// zombie.vehicles.VehicleParts, reachable only via vehicle:getParts(). Every
// call site in PanelBridge.lua used to invoke them directly on the vehicle
// object, so every one always returned nil regardless of the vehicle's real
// part state.
//
// THE FAKE OBJECTS BELOW ARE DELIBERATELY SPLIT INTO TWO SEPARATE LUA TABLES
// (FakeVehicle vs FakeVehicleParts), each carrying only the methods that
// class genuinely has, to make a wrong-receiver call FAIL LOUDLY (missing
// method -> invoke() returns false, not a silent nil-that-looks-plausible)
// instead of quietly returning a coincidentally-plausible value. This is the
// actual bug shape: "does this method exist" says yes for all five, so the
// stub has to model RECEIVER identity, not just method presence, or it would
// pass on both the broken and fixed code.

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

// A part whose condition is below its max -- something for vehicleRepair to
// actually do, and something whose max/current values a wrong-receiver call
// could never see. getInventoryItem is nil so the getInventoryItem/item
// branches are skipped, keeping the fixture minimal.
function luaFakePart({ id, condition = 40, conditionMax = 40, hasDoor = false } = {}) {
  return `
{
  id = "${id}",
  condition = ${condition},
  door = ${hasDoor ? '{ locked = true, setLocked = function(self, v) self.locked = v end }' : 'nil'},
  getCondition = function(self) return self.condition end,
  setCondition = function(self, v) self.condition = v; return true end,
  getInventoryItem = function(self) return nil end,
  getMechanicSkillInstaller = function(self) return nil end,
  ${hasDoor ? `getDoor = function(self) return self.door end,` : ''}
}`;
}

const STUBS = `
FakeEngine = ${luaFakePart({ id: 'Engine', condition: 5, conditionMax: 100 })}
FakeDoorPart = ${luaFakePart({ id: 'Door', hasDoor: true })}

-- The class that actually carries getPartCount/getPartByIndex/getPartById/
-- getBattery/getBatteryCharge in real B42 (zombie.vehicles.VehicleParts).
FakeVehicleParts = {
  items = { FakeEngine, FakeDoorPart },
  battery = { charge = 61, getInventoryItem = function(self) return nil end },
}
function FakeVehicleParts:getPartCount() return #self.items end
function FakeVehicleParts:getPartByIndex(i) return self.items[i + 1] end
function FakeVehicleParts:getPartById(id)
  for _, p in ipairs(self.items) do
    if p.id == id then return p end
  end
  return nil
end
function FakeVehicleParts:getBattery() return self.battery end
function FakeVehicleParts:getBatteryCharge() return self.battery.charge end

-- The vehicle object itself (zombie.vehicles.BaseVehicle) -- deliberately
-- carries NONE of getPartCount/getPartByIndex/getPartById/getBattery/
-- getBatteryCharge, only getParts() and genuinely-real BaseVehicle methods.
-- A call that (wrongly) targets the vehicle directly for any of those five
-- hits a missing method and comes back nil/false through PanelBridge.invoke,
-- exactly like the real game does.
FakeVehicle = { id = 1 }
function FakeVehicle:getId() return self.id end
function FakeVehicle:getParts() return FakeVehicleParts end
function FakeVehicle:transmitPartCondition(part) return true end
function FakeVehicle:transmitPartItem(part) return true end
function FakeVehicle:transmitPartModData(part) return true end
function FakeVehicle:updatePartStats() return true end
function FakeVehicle:updateBulletStats() return true end
function FakeVehicle:setHotwired(v) return true end
function FakeVehicle:setHotwiredBroken(v) return true end
function FakeVehicle:setKeysInIgnition(v) return true end
function FakeVehicle:setTrunkLocked(v) return true end
function FakeVehicle:startEngine() self.engineStarted = true end

FakeVehicleList = { FakeVehicle }
function FakeVehicleList:size() return 1 end
function FakeVehicleList:get(i) return self[i + 1] end

FakeCell = {}
function FakeCell:getVehicles() return FakeVehicleList end

FakeWorld = {}
function FakeWorld:getCell() return FakeCell end
getWorld = function() return FakeWorld end
`;

describe('PanelBridge.lua vehicle handlers -- getPartCount/getPartByIndex/getPartById/getBattery/getBatteryCharge route through vehicle:getParts(), not the vehicle itself', () => {
  it('vehicleRepair: repairs a real below-max part reachable only via getParts()', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler('vehicleRepair', { vehicleId: 1 });

    // Before the fix this always failed with the misleading
    // "No repairable vehicle parts available", even though FakeEngine is
    // sitting right there below its max condition -- the call just never
    // reached it because getPartCount/getPartByIndex targeted FakeVehicle
    // (which doesn't have them) instead of FakeVehicleParts.
    expect(result.ok).toBe(true);
    expect(result.data.parts).toBeGreaterThan(0);

    bridge.run('__ENGINE_COND = FakeEngine.condition');
    expect(bridge.getGlobal('__ENGINE_COND')).toBe(100); // repaired to its conditionMax fallback... see note below
  });

  it('vehicleRepair: an honest, specific error when the vehicle genuinely has zero parts', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run('FakeVehicleParts.items = {}');

    const result = bridge.callHandler('vehicleRepair', { vehicleId: 1 });
    expect(result.ok).toBe(false);
    // Names the real reason (0 parts) instead of the old blanket message
    // that fired identically whether there were 0 parts or 40.
    expect(result.err).toMatch(/0 parts/);
  });

  it('vehicleRepair: an honest error naming getParts() when the vehicle has no parts container at all', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run('function FakeVehicle:getParts() return nil end');

    const result = bridge.callHandler('vehicleRepair', { vehicleId: 1 });
    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/getParts/);
  });

  it('vehicleHotwire: unlocks a door reachable only via getParts(), does not crash when parts is nil', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler('vehicleHotwire', { vehicleId: 1 });
    expect(result.ok).toBe(true);

    bridge.run('__DOOR_LOCKED = FakeDoorPart:getDoor().locked');
    expect(bridge.getGlobal('__DOOR_LOCKED')).toBe(false);

    // Negative control / crash guard: getParts() returning nil must not
    // throw (the whole point of guarding every parts-object call).
    const bridge2 = loadPanelBridge(LUA_PATH, STUBS);
    bridge2.run('function FakeVehicle:getParts() return nil end');
    let result2;
    expect(() => {
      result2 = bridge2.callHandler('vehicleHotwire', { vehicleId: 1 });
    }).not.toThrow();
    expect(result2.ok).toBe(true);
  });

  it('getVehiclesDetailed: batteryCharge is read from getParts(), not the vehicle directly', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler('getVehiclesDetailed', {});
    expect(result.ok).toBe(true);
    expect(result.data.vehicles[0].batteryCharge).toBe(61);
  });

  it('vehicleSetBattery: getBattery() reachable via getParts() lets the real charge-delta path run', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS + `
VehicleUtils = {
  chargeBattery = function(vehicle, delta) FakeVehicleParts.battery.charge = FakeVehicleParts.battery.charge + delta * 100 end,
}
function FakeVehicleParts.battery:getInventoryItem() return { getCurrentUsesFloat = function() return FakeVehicleParts.battery.charge / 100 end } end
`);
    const result = bridge.callHandler('vehicleSetBattery', { vehicleId: 1, charge: 90 });
    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    bridge.run('__CHARGE = FakeVehicleParts.battery.charge');
    expect(bridge.getGlobal('__CHARGE')).toBeCloseTo(90, 0);
  });

  it('vehicleSetBattery: honest, specific error when neither the battery-item path nor setBatteryCharge exists', () => {
    // setBatteryCharge genuinely does not exist anywhere in the real B42
    // vehicle API (no near-miss on BaseVehicle, VehicleParts, or
    // VehiclePart) -- rerouting the receiver cannot fix this one. FakeVehicle
    // here has no setBatteryCharge at all, matching that reality.
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler('vehicleSetBattery', { vehicleId: 1, charge: 90 });
    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/setBatteryCharge does not exist/);
  });
});
