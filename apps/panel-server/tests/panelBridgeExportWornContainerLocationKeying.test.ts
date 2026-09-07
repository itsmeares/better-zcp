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

LocationTorsoA = setmetatable({}, { __tostring = function() return "Torso" end })
LocationTorsoB = setmetatable({}, { __tostring = function() return "Torso" end })

FakeSubItem1 = {}
function FakeSubItem1:getFullType() return "Base.Bandage" end
function FakeSubItem1:getType() return "Bandage" end
function FakeSubItem1:getName() return "Bandage" end
FakeSubItemList1 = { FakeSubItem1 }
function FakeSubItemList1:size() return 1 end
function FakeSubItemList1:get(i) return self[i + 1] end
FakeContainer1 = {}
function FakeContainer1:getItems() return FakeSubItemList1 end

FakeSubItem2 = {}
function FakeSubItem2:getFullType() return "Base.Nails" end
function FakeSubItem2:getType() return "Nails" end
function FakeSubItem2:getName() return "Nails" end
FakeSubItemList2 = { FakeSubItem2 }
function FakeSubItemList2:size() return 1 end
function FakeSubItemList2:get(i) return self[i + 1] end
FakeContainer2 = {}
function FakeContainer2:getItems() return FakeSubItemList2 end

FakeBackpackItem = {}
function FakeBackpackItem:getFullType() return "Base.Backpack" end
function FakeBackpackItem:getCondition() return 100 end
function FakeBackpackItem:getItemContainer() return FakeContainer1 end

FakeBagItem = {}
function FakeBagItem:getFullType() return "Base.Bag" end
function FakeBagItem:getCondition() return 100 end
function FakeBagItem:getItemContainer() return FakeContainer2 end

FakeWorn1 = {}
function FakeWorn1:getItem() return FakeBackpackItem end
function FakeWorn1:getLocation() return LocationTorsoA end

FakeWorn2 = {}
function FakeWorn2:getItem() return FakeBagItem end
function FakeWorn2:getLocation() return LocationTorsoB end

FakeWornList = { FakeWorn1, FakeWorn2 }
function FakeWornList:size() return 2 end
function FakeWornList:get(i) return self[i + 1] end

FakePlayer = {}
function FakePlayer:getUsername() return "Fielder" end
function FakePlayer:getDisplayName() return "Fielder" end
function FakePlayer:getWornItems() return FakeWornList end
function FakePlayer:getInventory() return nil end
function FakePlayer:getCharacterTraits() return nil end
function FakePlayer:getDescriptor() return nil end
function FakePlayer:getTraits() return nil end

FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end
`;

describe('PanelBridge.lua handlers.exportPlayerData -- worn-container bagItems keying (Finding 4)', () => {
  it('two containers at the same conceptual location merge into one bagInventory entry, measured at the Lua table level itself', () => {
    const bridge = loadPanelBridge(LUA_PATH, BASE);
    bridge.run(`
      local ok, data = PanelBridgeModule.handlers.exportPlayerData({ username = "Fielder" })
      local count = 0
      for _ in pairs(data.bagInventory) do count = count + 1 end
      __BAG_KEY_COUNT = count
      __BAG_DIAG = data._diagnostics.bagItems
    `);

    const bagKeyCount = bridge.getGlobal('__BAG_KEY_COUNT');
    const bagDiag = bridge.getGlobal('__BAG_DIAG');

    expect(bagDiag).toMatch(/^2 items in/);
    expect(bagKeyCount).toBe(1);
  });
});
