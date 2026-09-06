import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// Regression coverage for a copy-paste bug found while auditing every
// PanelBridge.lua handler for "reports success without checking whether the
// thing it claims to do happened" (the b376b2c defect family). This is the
// mirror image: handlers.vehicleHotwire referenced `results`/`executed`,
// two locals that are only ever declared inside a DIFFERENT handler
// (runEventSequence, `local results = {}` / `local executed = 0`) -- not
// inside vehicleHotwire itself. Every real handler dispatch wraps the call
// in pcall (see processSingleCommand), so this didn't crash the server, but
// it meant EVERY successful hotwire (engine started, doors unlocked) was
// reported back to the operator as "Handler crashed: bad argument #1 to
// 'ipairs' (table expected, got no value)" -- a fully working operation
// permanently misreported as broken.

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

const STUBS = `
FakeVehicle = { id = 1 }
function FakeVehicle:getId() return self.id end
function FakeVehicle:setHotwired(v) self.hotwired = v return true end
function FakeVehicle:setHotwiredBroken(v) return true end
function FakeVehicle:setKeysInIgnition(v) return true end
-- getPartCount lives on VehicleParts, reached only via vehicle:getParts() --
-- not on the vehicle object itself. An empty parts container here matches
-- this test's original intent (no doors to unlock) without modeling the
-- wrong-receiver call the real code no longer makes.
FakeVehicleParts = {}
function FakeVehicleParts:getPartCount() return 0 end
function FakeVehicle:getParts() return FakeVehicleParts end
function FakeVehicle:setTrunkLocked(v) return true end
function FakeVehicle:startEngine() self.engineStarted = true end
function FakeVehicle:transmitEngine() return true end
function FakeVehicle:transmitVehicle() return true end
function FakeVehicle:updateFlags() return true end

FakeVehicleList = { FakeVehicle }
function FakeVehicleList:size() return 1 end
function FakeVehicleList:get(i) return self[i + 1] end

FakeCell = {}
function FakeCell:getVehicles() return FakeVehicleList end

FakeWorld = {}
function FakeWorld:getCell() return FakeCell end
getWorld = function() return FakeWorld end
`;

describe('PanelBridge.lua handlers.vehicleHotwire -- undefined-global crash on success', () => {
  it('does not crash on a fully successful hotwire (a real engine-start reported as a handler crash is the bug)', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);

    // Before the fix, this call always threw a Lua runtime error --
    // "bad argument #1 to 'ipairs' (table expected, got no value)" --
    // because it hit `for _, result in ipairs(results) do` with `results`
    // undefined in this handler's scope, right after a successful hotwire.
    let result;
    expect(() => {
      result = bridge.callHandler('vehicleHotwire', { vehicleId: 1 });
    }).not.toThrow();

    expect(result.ok).toBe(true);
    expect(result.data.message).toBe('Vehicle hotwired and engine started');
    expect(result.data.actions).toContain('hotwired');
    expect(result.data.actions).toContain('startEngine');
  });
});
