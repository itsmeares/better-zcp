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

Perks = { Fitness = { id = "Fitness" }, Strength = { id = "Strength" } }

FakeXp = {}
function FakeXp:getXP(perk) return 42 end

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

FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end
`;

describe('PanelBridge.lua handlers.exportPlayerData -- a throw in perks/recipes/kills no longer costs the rest of the export', () => {
  it('one perk throwing in getPerkLevel still returns the other perks, plus everything else in the export', () => {
    const bridge = loadPanelBridge(LUA_PATH, BASE + `
function FakePlayer:getPerkLevel(perk)
    if perk.id == "Strength" then error("simulated engine failure reading Strength") end
    return 3
end
`);
    const result = bridge.callHandler('exportPlayerData', { username: 'Fielder' });

    expect(result.ok).toBe(true);
    expect(result.data.username).toBe('Fielder');
    expect(result.data.perks.Fitness.level).toBe(3);
    expect(result.data.perks.Strength).toBeUndefined();
    expect(result.data.recipes).toEqual({});
    expect(result.data.kills.zombies).toBe(7);
  });

  it('getKnownRecipes() itself throwing still returns perks/kills/username -- not a total export failure', () => {
    const bridge = loadPanelBridge(LUA_PATH, BASE + `
function FakePlayer:getKnownRecipes() error("simulated engine failure") end
`);
    const result = bridge.callHandler('exportPlayerData', { username: 'Fielder' });

    expect(result.ok).toBe(true);
    expect(result.data.recipes).toEqual({});
    expect(result.data._diagnostics.recipes).toMatch(/getKnownRecipes/);
    expect(result.data.perks.Fitness.level).toBe(3);
    expect(result.data.username).toBe('Fielder');
  });

  it('getZombieKills() throwing still returns the rest of the export, with kills.zombies simply omitted (not a fabricated 0)', () => {
    const bridge = loadPanelBridge(LUA_PATH, BASE + `
function FakePlayer:getZombieKills() error("simulated engine failure") end
`);
    const result = bridge.callHandler('exportPlayerData', { username: 'Fielder' });

    expect(result.ok).toBe(true);
    expect(result.data.kills.zombies).toBeUndefined();
    expect(result.data.username).toBe('Fielder');
    expect(result.data.perks.Fitness.level).toBe(3);
  });
});

describe('PanelBridge.lua handlers.importPlayerData -- getXp() throwing no longer aborts the independent inventory restore', () => {
  it('restores inventory even when getXp() throws during the perk-restore section', () => {
    const bridge = loadPanelBridge(LUA_PATH, BASE + `
function FakePlayer:getXp() error("simulated engine failure") end

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
