import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-31, clearing the last two PROVISIONAL entries in the verify-
// enforcement gate (panelBridgeHandlerVerifyEnforcement.test.js) --
// triggerSwarmEvent and removeVehicle. See that file's own comment for the
// full jar evidence (javap -c against the real B42 jar on Tower) proving
// both treatments are safe, not just plausible.

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

// ---------------------------------------------------------------------------
// triggerSwarmEvent -- same VirtualZombieManager-first / fire-and-forget-
// fallback split as spawnHordeNearPlayer (see
// panelBridgeSpawnHordeFabricatedCount.test.js, which this mirrors).
// ---------------------------------------------------------------------------

const ZOMBRAND_STUB = `ZombRand = function(n) return 0 end`;

const VZM_STUBS = ZOMBRAND_STUB + `
FakeVZM = {}
function FakeVZM:createRealZombieNow(x, y, z) return { x = x, y = y, z = z } end
VirtualZombieManager = { instance = FakeVZM }
`;

const NOOP_VZM_STUBS = ZOMBRAND_STUB + `
FakeVZM = {}
function FakeVZM:createRealZombieNow(x, y, z) return nil end
VirtualZombieManager = { instance = FakeVZM }
`;

const FALLBACK_ONLY_STUBS = ZOMBRAND_STUB + `
FakeZPM = {}
function FakeZPM:createHordeInAreaTo(...) end
ZombiePopulationManager = { instance = FakeZPM }
`;

describe('PanelBridge.lua handlers.triggerSwarmEvent -- VirtualZombieManager-first, honest fallback', () => {
  it('reports a real per-zombie count when VirtualZombieManager returns zombies (verified="confirmed")', () => {
    const bridge = loadPanelBridge(LUA_PATH, VZM_STUBS);
    const result = bridge.callHandler('triggerSwarmEvent', { count: 5, x1: 0, y1: 0, x2: 10, y2: 10 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(result.data.spawned).toBe(5);
    expect(result.data.method).toBe('VirtualZombieManager.createRealZombieNow');
  });

  it('does not report success when the coordinate spawn method creates no zombies', () => {
    const bridge = loadPanelBridge(LUA_PATH, NOOP_VZM_STUBS);
    const result = bridge.callHandler('triggerSwarmEvent', { count: 5, x1: 0, y1: 0, x2: 10, y2: 10 });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/no zombies were created/);
  });

  it('must NOT claim a spawned count from the createHordeInAreaTo fallback (verified="unverifiable", spawned unset)', () => {
    const bridge = loadPanelBridge(LUA_PATH, FALLBACK_ONLY_STUBS);
    const result = bridge.callHandler('triggerSwarmEvent', { count: 50, x1: 0, y1: 0, x2: 10, y2: 10 });

    expect(result.ok).toBe(true);
    expect(result.data.method).toBe('createHordeInAreaTo');
    expect(result.data.verified).toBe('unverifiable');
    expect(result.data.spawned == null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// removeVehicle -- re-checks findVehicleById() after removal and gates
// `verified` on the vehicle's genuine absence.
// ---------------------------------------------------------------------------

function worldStub(cellDecl) {
  return `
${cellDecl}
FakeWorld = {}
function FakeWorld:getCell() return FakeCell end
getWorld = function() return FakeWorld end
`;
}

describe('PanelBridge.lua handlers.removeVehicle -- verified gated on genuine absence, not just a non-throwing call', () => {
  it('reports verified="confirmed" when the vehicle is genuinely gone after removal', () => {
    const cell = `
FakeCell = {}
FakeVehicle1 = { id = 7 }
function FakeVehicle1:getId() return self.id end
function FakeVehicle1:getX() return 50 end
function FakeVehicle1:getY() return 50 end
function FakeVehicle1:getScriptName() return "TestCar" end
function FakeVehicle1:permanentlyRemove()
    for i, v in ipairs(FakeVehicleList) do
        if v == FakeVehicle1 then table.remove(FakeVehicleList, i) break end
    end
    return true
end
FakeVehicleList = { FakeVehicle1 }
function FakeVehicleList:size() return #self end
function FakeVehicleList:get(i) return self[i + 1] end
function FakeCell:getVehicles() return FakeVehicleList end
`;
    const bridge = loadPanelBridge(LUA_PATH, worldStub(cell));
    const result = bridge.callHandler('removeVehicle', { vehicleId: 7 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('reports ok=false when the removal call succeeds but the vehicle is STILL present afterward (the exact bug this closes)', () => {
    const cell = `
FakeCell = {}
FakeVehicle1 = { id = 7 }
function FakeVehicle1:getId() return self.id end
function FakeVehicle1:getX() return 50 end
function FakeVehicle1:getY() return 50 end
function FakeVehicle1:getScriptName() return "TestCar" end
-- Claims success (no throw) but never actually removes itself -- models a
-- build where permanentlyRemove()/removeFromWorld() no-op instead of
-- genuinely detaching the vehicle from the cell's collection.
function FakeVehicle1:permanentlyRemove() return true end
FakeVehicleList = { FakeVehicle1 }
function FakeVehicleList:size() return #self end
function FakeVehicleList:get(i) return self[i + 1] end
function FakeCell:getVehicles() return FakeVehicleList end
`;
    const bridge = loadPanelBridge(LUA_PATH, worldStub(cell));
    const result = bridge.callHandler('removeVehicle', { vehicleId: 7 });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/still present/);
  });

  it('reports verified="unverifiable" (not a false failure) when the list becomes unreadable only on the post-removal re-check', () => {
    const cell = `
FakeCell = {}
FakeVehicle1 = { id = 7 }
function FakeVehicle1:getId() return self.id end
function FakeVehicle1:getX() return 50 end
function FakeVehicle1:getY() return 50 end
function FakeVehicle1:getScriptName() return "TestCar" end
function FakeVehicle1:permanentlyRemove() return true end
FakeVehicleList = { FakeVehicle1 }
FakeCallCount = 0
function FakeCell:getVehicles()
    FakeCallCount = FakeCallCount + 1
    if FakeCallCount == 1 then return FakeVehicleList end
    -- Second call (the post-removal re-check): the collection itself is now
    -- unreadable -- size() throws. A genuinely different failure than "not
    -- found", and must not be reported as a confirmed "still there".
    local broken = {}
    function broken:size() error("collection invalidated") end
    return broken
end
function FakeVehicleList:size() return #self end
function FakeVehicleList:get(i) return self[i + 1] end
`;
    const bridge = loadPanelBridge(LUA_PATH, worldStub(cell));
    const result = bridge.callHandler('removeVehicle', { vehicleId: 7 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('unverifiable');
  });
});
