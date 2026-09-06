import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, operator ruling on bridge-getvehicles-runtime-type-unknown:
// IsoCell.getVehicles()'s compile-time descriptor declares java.util.Set --
// no get(int) at all -- yet this file has always called size()/get(i)
// unconditionally, matching real vanilla CLIENT Lua (ISVehicleBloodUI.lua)
// which does the exact same thing. PZ's Lua binding reflects against the
// RUNTIME object, not the descriptor, so which shape actually comes back on
// a live server was left correctly unresolved by Kevin's jar audit -- it
// cannot be settled from static analysis alone.
//
// The operator did not ask for that answer. He asked for the code to stop
// caring: return the full vehicle list whichever shape comes back, and fail
// loudly instead of silently reporting zero vehicles if NEITHER shape can be
// read. These tests do not claim to know which shape the real jar returns --
// they prove the bridge's own collectVehicles() helper handles both of the
// only two shapes that are structurally possible (indexable, and
// iterator-only-Collection), plus the genuinely-broken case where a
// collection reports a nonzero size but neither access pattern can read a
// single element from it.

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

function fakeVehicleDecl(name, id, x, y) {
  return `
${name} = { id = ${id}, x = ${x}, y = ${y} }
function ${name}:getId() return self.id end
function ${name}:getX() return self.x end
function ${name}:getY() return self.y end
function ${name}:getZ() return 0 end
function ${name}:getScriptName() return "TestCar${id}" end
function ${name}:permanentlyRemove() return true end
`;
}

describe('PanelBridge.lua vehicle handlers -- collectVehicles works regardless of the vehicle-list runtime shape', () => {
  it('List-shaped (size+get(i) both work): getVehiclesDetailed returns every vehicle -- unchanged baseline', () => {
    const cell = `
FakeCell = {}
${fakeVehicleDecl('FakeVehicle1', 1, 100, 100)}
${fakeVehicleDecl('FakeVehicle2', 2, 200, 200)}
FakeVehicleList = { FakeVehicle1, FakeVehicle2 }
function FakeVehicleList:size() return 2 end
function FakeVehicleList:get(i) return self[i + 1] end
function FakeCell:getVehicles() return FakeVehicleList end
`;
    const bridge = loadPanelBridge(LUA_PATH, worldStub(cell));
    const result = bridge.callHandler('getVehiclesDetailed', {});

    expect(result.ok).toBe(true);
    expect(result.data.count).toBe(2);
    expect(result.data.vehicles.map((v) => v.id).sort()).toEqual([1, 2]);
  });

  it('Set-shaped (size works, get(i) does not exist at all, only iterator()): getVehiclesDetailed still returns every vehicle via the fallback', () => {
    const cell = `
FakeCell = {}
${fakeVehicleDecl('FakeVehicle1', 1, 100, 100)}
${fakeVehicleDecl('FakeVehicle2', 2, 200, 200)}
-- Deliberately NO get() method on this table -- models a genuine
-- java.util.Set, which has no get(int) at all. Only size() and iterator()
-- exist, which is what every java.util.Collection guarantees regardless of
-- concrete type.
FakeVehicleSet = {}
FakeVehicleSet._items = { FakeVehicle1, FakeVehicle2 }
function FakeVehicleSet:size() return #self._items end
function FakeVehicleSet:iterator()
    local items = self._items
    local it = { i = 0 }
    function it:hasNext() return self.i < #items end
    function it:next() self.i = self.i + 1; return items[self.i] end
    return it
end
function FakeCell:getVehicles() return FakeVehicleSet end
`;
    const bridge = loadPanelBridge(LUA_PATH, worldStub(cell));
    const result = bridge.callHandler('getVehiclesDetailed', {});

    expect(result.ok).toBe(true);
    expect(result.data.count).toBe(2);
    expect(result.data.skipped).toBe(0);
    expect(result.data.vehicles.map((v) => v.id).sort()).toEqual([1, 2]);
  });

  it('Neither shape readable (size() reports 2 but get(i) and iterator() both fail): getVehiclesDetailed fails loudly instead of reporting zero vehicles', () => {
    const cell = `
FakeCell = {}
FakeVehicleBroken = {}
function FakeVehicleBroken:size() return 2 end
-- No get(), no iterator() -- the "worst case" this bridge cannot read at all.
function FakeCell:getVehicles() return FakeVehicleBroken end
`;
    const bridge = loadPanelBridge(LUA_PATH, worldStub(cell));
    const result = bridge.callHandler('getVehiclesDetailed', {});

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/2 vehicle\(s\)/);
    expect(result.err).toMatch(/neither get\(i\) nor iterator\(\)/);
  });

  it('Zero real vehicles (size() genuinely reports 0) is still a clean success, not confused with the unreadable case', () => {
    const cell = `
FakeCell = {}
FakeVehicleEmpty = {}
function FakeVehicleEmpty:size() return 0 end
function FakeVehicleEmpty:get(i) return nil end
function FakeCell:getVehicles() return FakeVehicleEmpty end
`;
    const bridge = loadPanelBridge(LUA_PATH, worldStub(cell));
    const result = bridge.callHandler('getVehiclesDetailed', {});

    expect(result.ok).toBe(true);
    expect(result.data.count).toBe(0);
    expect(result.data.vehicles).toEqual({});
  });

  it('removeVehiclesInArea: Set-shaped collection still finds and removes an in-bounds vehicle via the iterator fallback', () => {
    const cell = `
FakeCell = {}
${fakeVehicleDecl('FakeVehicle1', 1, 100, 100)}
FakeVehicleSet = {}
FakeVehicleSet._items = { FakeVehicle1 }
function FakeVehicleSet:size() return #self._items end
function FakeVehicleSet:iterator()
    local items = self._items
    local it = { i = 0 }
    function it:hasNext() return self.i < #items end
    function it:next() self.i = self.i + 1; return items[self.i] end
    return it
end
function FakeCell:getVehicles() return FakeVehicleSet end
-- Overrides fakeVehicleDecl's always-true stub: removeVehiclesInArea now
-- re-verifies each removal against a fresh getVehiclesList() read (same
-- fix as removeVehicle's own 2026-08-31 verify-enforcement pass, applied
-- to this sibling handler since it had the identical "invoke didn't throw"
-- gap), so the fake must actually leave the set for that re-check to see --
-- same reasoning and same real-jar backing as removeVehicle's test below.
function FakeVehicle1:permanentlyRemove()
    for i, v in ipairs(FakeVehicleSet._items) do
        if v == FakeVehicle1 then
            table.remove(FakeVehicleSet._items, i)
            break
        end
    end
    return true
end
`;
    const bridge = loadPanelBridge(LUA_PATH, worldStub(cell));
    const result = bridge.callHandler('removeVehiclesInArea', { minX: 90, minY: 90, maxX: 110, maxY: 110 });

    expect(result.ok).toBe(true);
    expect(result.data.removed).toBe(1);
    expect(result.data.vehicles[0].id).toBe(1);
    expect(result.data.verified).toBe('confirmed');
  });

  it('removeVehiclesInArea: a removal call that does not throw but leaves the vehicle in place is NOT counted as removed (verify-by-effect, same class of bug removeVehicle was fixed for)', () => {
    const cell = `
FakeCell = {}
${fakeVehicleDecl('FakeVehicle1', 1, 100, 100)}
FakeVehicleList = { FakeVehicle1 }
function FakeVehicleList:size() return 1 end
function FakeVehicleList:get(i) return self[i + 1] end
function FakeCell:getVehicles() return FakeVehicleList end
`;
    // fakeVehicleDecl's default permanentlyRemove() just "return true" with
    // no actual mutation -- the exact shape of the original bug (a call
    // that didn't throw, reported as a real removal with no confirmation).
    const bridge = loadPanelBridge(LUA_PATH, worldStub(cell));
    const result = bridge.callHandler('removeVehiclesInArea', { minX: 90, minY: 90, maxX: 110, maxY: 110 });

    expect(result.ok).toBe(true);
    expect(result.data.removed).toBe(0);
    // An empty Lua table has no integer-keyed entries, so the harness's
    // luaToJs converts it to {} not [] (see its own comment) -- matches the
    // existing "Zero real vehicles" test above's identical assertion shape.
    expect(result.data.vehicles).toEqual({});
    expect(result.data.verified).toBe('confirmed');
  });

  it('removeVehiclesInArea: neither shape readable fails loudly instead of reporting "0 vehicle(s) removed"', () => {
    const cell = `
FakeCell = {}
FakeVehicleBroken = {}
function FakeVehicleBroken:size() return 3 end
function FakeCell:getVehicles() return FakeVehicleBroken end
`;
    const bridge = loadPanelBridge(LUA_PATH, worldStub(cell));
    const result = bridge.callHandler('removeVehiclesInArea', { minX: 0, minY: 0, maxX: 1000, maxY: 1000 });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/3 vehicle\(s\)/);
  });

  it('removeVehicle (via findVehicleById): Set-shaped collection still locates the vehicle by id through the iterator fallback', () => {
    const cell = `
FakeCell = {}
${fakeVehicleDecl('FakeVehicle1', 7, 50, 50)}
FakeVehicleSet = {}
FakeVehicleSet._items = { FakeVehicle1 }
function FakeVehicleSet:size() return #self._items end
function FakeVehicleSet:iterator()
    local items = self._items
    local it = { i = 0 }
    function it:hasNext() return self.i < #items end
    function it:next() self.i = self.i + 1; return items[self.i] end
    return it
end
function FakeCell:getVehicles() return FakeVehicleSet end
-- Overrides fakeVehicleDecl's always-true stub: removeVehicle now re-checks
-- findVehicleById() after removal (2026-08-31, verify-enforcement-
-- provisionals), so the fake must actually leave the set for that re-check
-- to see, the same way the real BaseVehicle.permanentlyRemove() ->
-- removeFromWorld() synchronously removes itself from IsoCell's live vehicle
-- Set (confirmed via javap -c -- see the handler's own comment).
function FakeVehicle1:permanentlyRemove()
    for i, v in ipairs(FakeVehicleSet._items) do
        if v == FakeVehicle1 then
            table.remove(FakeVehicleSet._items, i)
            break
        end
    end
    return true
end
`;
    const bridge = loadPanelBridge(LUA_PATH, worldStub(cell));
    // removeVehicle is a thin wrapper over findVehicleById + a removal call --
    // reusing it here proves findVehicleById itself resolves through the
    // fallback, without needing a second bespoke handler-specific stub.
    const result = bridge.callHandler('removeVehicle', { vehicleId: 7 });

    expect(result.ok).toBe(true);
    expect(result.data.vehicleId).toBe(7);
  });
});
