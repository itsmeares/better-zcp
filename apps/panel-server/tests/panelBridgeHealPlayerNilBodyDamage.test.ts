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

function stubsWithBodyDamage(hasBodyDamage) {
  return `
FakeBodyPart = {}
function FakeBodyPart:RestoreToFullHealth() end
function FakeBodyPart:SetFakeInfected(v) end

FakeBodyPartList = { FakeBodyPart }
function FakeBodyPartList:size() return 1 end
function FakeBodyPartList:get(i) return self[i + 1] end

FakeBodyDamage = {}
function FakeBodyDamage:getBodyParts() return FakeBodyPartList end

FakePlayer = { username = "Test" }
function FakePlayer:getUsername() return self.username end
function FakePlayer:getBodyDamage()
  ${hasBodyDamage ? 'return FakeBodyDamage' : 'return nil'}
end

FakePlayerList = { FakePlayer }
function FakePlayerList:size() return 1 end
function FakePlayerList:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakePlayerList end
`;
}

describe('PanelBridge.lua handlers.healPlayer -- nil bodyDamage must not report success', () => {
  it('heals and reports success when bodyDamage is available', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubsWithBodyDamage(true));
    const result = bridge.callHandler('healPlayer', { username: 'Test' });

    expect(result.ok).toBe(true);
    expect(result.data.healed.bodyDamage).toBe(true);
  });

  it('must NOT report success when bodyDamage is nil (nothing was healed)', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubsWithBodyDamage(false));
    const result = bridge.callHandler('healPlayer', { username: 'Test' });

    expect(result.ok).toBe(false);
    expect(typeof result.err).toBe('string');
    expect(result.err.length).toBeGreaterThan(0);
  });
});
