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
FakePlayer = {}
function FakePlayer:getUsername() return "Fielder" end
function FakePlayer:sendObjectChange(what) end

FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end
`;

describe('PanelBridge.lua handlers.giveItem -- getInventory() routed through tryGet', () => {
  it('still adds items normally on the working path', () => {
    const bridge = loadPanelBridge(LUA_PATH, BASE + `
FakeInventory = {}
function FakeInventory:AddItem(fullType) return { fullType = fullType } end
function FakePlayer:getInventory() return FakeInventory end
`);
    const result = bridge.callHandler('giveItem', { username: 'Fielder', itemType: 'Base.Axe', count: 1 });

    expect(result.ok).toBe(true);
  });

  it('getInventory() throwing produces the handler\'s own friendly error, not a raw crash', () => {
    const bridge = loadPanelBridge(LUA_PATH, BASE + `
function FakePlayer:getInventory() error("simulated engine failure") end
`);
    const result = bridge.callHandler('giveItem', { username: 'Fielder', itemType: 'Base.Axe', count: 1 });

    expect(result.ok).toBe(false);
    expect(result.err).toBe('Could not access player inventory');
  });
});
