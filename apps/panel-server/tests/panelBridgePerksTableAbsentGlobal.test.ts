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

const BASE = `
getServerName = function() return "TestServer" end

FakeXp = {}
function FakeXp:getXP(perk) return 42 end
function FakeXp:setXPToLevel(perk, level) end

FakePlayer = {}
function FakePlayer:getUsername() return "Fielder" end
function FakePlayer:getDisplayName() return "Fielder" end
function FakePlayer:getWornItems() return nil end
function FakePlayer:getInventory() return nil end
function FakePlayer:getCharacterTraits() return nil end
function FakePlayer:getDescriptor() return nil end
function FakePlayer:getTraits() return nil end
function FakePlayer:getZombieKills() return 7 end
function FakePlayer:getXp() return FakeXp end
function FakePlayer:getPerkLevel(perk) return 3 end
function FakePlayer:getKnownRecipes() return nil end
function FakePlayer:level0(perk) end
function FakePlayer:LevelPerk(perk, removePick) end

FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end
getPlayerByUsername = function(name) if name == "Fielder" then return FakePlayer end return nil end
-- Perks deliberately NOT defined at all -- models the worst case: a
-- genuinely absent global, not merely one missing perk name.
`;

describe('PanelBridge.lua exportPlayerData/importPlayerData -- an absent Perks global no longer crashes the whole handler', () => {
  it('exportPlayerData: still returns username/traits/inventory/kills even though Perks is entirely absent', () => {
    const bridge = loadPanelBridge(LUA_PATH, BASE);
    const result = bridge.callHandler('exportPlayerData', { username: 'Fielder' });

    expect(result.ok).toBe(true);
    expect(result.data.username).toBe('Fielder');
    expect(result.data.kills.zombies).toBe(7);
    expect(result.data.perks).toEqual({});
    expect(result.data._diagnostics.perks).toMatch(/failed to read/);
  });

  it('importPlayerData: inventory restore still runs even though Perks is entirely absent (perk restore degrades honestly instead of crashing)', () => {
    const bridge = loadPanelBridge(LUA_PATH, BASE + `
FakeContainer = { added = 0 }
function FakeContainer:AddItem(fullType) self.added = self.added + 1; return { fullType = fullType } end
function FakePlayer:getInventory() return FakeContainer end
`);
    const result = bridge.callHandler('importPlayerData', {
      username: 'Fielder',
      data: {
        perks: { Fitness: { level: 5, xp: 1000 } },
        inventory: [{ fullType: 'Base.Axe', count: 1 }],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.data.restored.perks).toBe(0);
    expect(result.data.restored.items).toBe(1);
  });
});
