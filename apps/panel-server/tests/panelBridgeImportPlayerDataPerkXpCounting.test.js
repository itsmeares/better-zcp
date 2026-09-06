import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, regression, item 3 (the jar-verified spec + the
// operator's own ruling): handlers.importPlayerData's perk-restore loop used
// to call `xp:setXP(perk, exactValue)` as the LAST statement inside the
// per-perk pcall, AFTER player:level0(perk) and the LevelPerk(perk, false)
// loop had already run as real side effects. xp:setXP(perk, value) does not
// exist anywhere in the confirmed API -- so that throw took the pcall down
// WITH IT, and restored.perks (incremented at the very end) never counted a
// perk whose level change had genuinely already landed. testing could not
// prove the alternative (getXP(perk) + AddXPNoMultiplier(perk, delta)) safe
// either -- possible clamping/rounding/level-boundary side effects without
// decompiling -- so the operator ruled: use setXPToLevel(perk, level)
// (exact, provable, threshold semantics), and count the restore once the
// real level change lands, not after an unprovable XP step.

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

function stubs({ setXPToLevelExists = true, setXPToLevelThrows = false } = {}) {
  const setXPToLevelDecl = setXPToLevelExists
    ? `function FakeXp:setXPToLevel(perk, level)
         if ${setXPToLevelThrows} then error("simulated engine failure") end
         self.lastSetLevel = level
         self.lastSetPerk = perk.id
       end`
    : '-- setXPToLevel deliberately not defined, models a build where it is also absent';

  return `
Perks = { Fitness = { id = "Fitness" }, Strength = { id = "Strength" } }

FakeXp = { lastSetLevel = nil, lastSetPerk = nil }
${setXPToLevelDecl}

FakePlayer = { levelHistory = {} }
function FakePlayer:getUsername() return "Fielder" end
function FakePlayer:getXp() return FakeXp end
function FakePlayer:level0(perk) end
function FakePlayer:LevelPerk(perk, removePick)
  table.insert(self.levelHistory, perk.id)
end
function FakePlayer:getInventory() return nil end

FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end
`;
}

describe('PanelBridge.lua handlers.importPlayerData -- perk XP restore counts the real level change, not the unprovable XP step', () => {
  it('setXPToLevel throwing does NOT undercount restored.perks -- the level change already landed for real', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs({ setXPToLevelThrows: true }));
    const result = bridge.callHandler('importPlayerData', {
      username: 'Fielder',
      data: { perks: { Fitness: { level: 5, xp: 1000 } } },
    });

    expect(result.ok).toBe(true);
    expect(result.data.restored.perks).toBe(1);
  });

  it('setXPToLevel not existing at all on this build does NOT undercount restored.perks either', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs({ setXPToLevelExists: false }));
    const result = bridge.callHandler('importPlayerData', {
      username: 'Fielder',
      data: { perks: { Fitness: { level: 5, xp: 1000 } } },
    });

    expect(result.ok).toBe(true);
    expect(result.data.restored.perks).toBe(1);
  });

  it('when setXPToLevel succeeds, it is actually called with the perk and the target level', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs({ setXPToLevelExists: true, setXPToLevelThrows: false }));
    bridge.callHandler('importPlayerData', {
      username: 'Fielder',
      data: { perks: { Fitness: { level: 5, xp: 1000 } } },
    });

    const xpState = bridge.getGlobal('FakeXp');
    expect(xpState.lastSetPerk).toBe('Fitness');
    expect(xpState.lastSetLevel).toBe(5);
  });

  it('multiple perks: level changes for ALL of them are counted even when their XP step throws', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs({ setXPToLevelThrows: true }));
    const result = bridge.callHandler('importPlayerData', {
      username: 'Fielder',
      data: {
        perks: {
          Fitness: { level: 5, xp: 1000 },
          Strength: { level: 3, xp: 200 },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.data.restored.perks).toBe(2);
  });
});
