import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-30, regression lens (c)#2, batch 1 -- the own words: "healPlayer's
// failure branch is NEVER TAKEN -- unconditional `return true` with failures
// buried in a nested errors array. Zero parts healed reads as clean success."
//
// This is a DIFFERENT case from the one panelBridgeHealPlayerNilBodyDamage.test.js
// already covers (player:getBodyDamage() returning nil entirely, gated by an
// early `if not bodyDamage then return false, nil, "..." end` guard that
// already existed). This file covers the deeper case: bodyDamage EXISTS, but
// the healing loop inside its own pcall either finds zero body parts to heal
// or throws partway through -- neither of which the existing nil-bodyDamage
// guard could catch, because both happen INSIDE the pcall the guard sits
// before.
//
// Per the earlier transport finding this same audit surfaced (the JS side's
// processResult() drops the data table on every failure -- only the third
// return slot survives), the fix puts the real reason in the error STRING,
// not just in the pre-existing nested healed.errors array that already lived
// in the data table and was already invisible to a caller checking `ok`
// alone.

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

function stubs({ bodyPartCount = 1, healThrows = false, syncAvailable = true } = {}) {
  const partsLua = Array.from({ length: bodyPartCount }, (_, i) => `FakeBodyPart${i}`).join(', ');
  const partDecls = Array.from({ length: bodyPartCount }, (_, i) => `
FakeBodyPart${i} = {}
function FakeBodyPart${i}:RestoreToFullHealth() ${healThrows ? 'error("part is corrupted")' : ''} end
function FakeBodyPart${i}:SetFakeInfected(v) end
`).join('\n');

  return `
${partDecls}
FakeBodyPartList = { ${partsLua} }
function FakeBodyPartList:size() return ${bodyPartCount} end
function FakeBodyPartList:get(i) return self[i + 1] end

FakeBodyDamage = {}
function FakeBodyDamage:getBodyParts() return FakeBodyPartList end

FakePlayer = { username = "Test" }
function FakePlayer:getUsername() return self.username end
function FakePlayer:getBodyDamage() return FakeBodyDamage end

FakePlayerList = { FakePlayer }
function FakePlayerList:size() return 1 end
function FakePlayerList:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakePlayerList end

${syncAvailable ? 'sendPlayerExtraInfo = function(p) end' : ''}
`;
}

describe('PanelBridge.lua handlers.healPlayer -- the failure branch must actually be reachable', () => {
  it('an EMPTY body part collection (bodyDamage exists, nothing to heal) is a real failure, not a clean success', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs({ bodyPartCount: 0 }));
    const result = bridge.callHandler('healPlayer', { username: 'Test' });

    expect(result.ok).toBe(false);
    expect(typeof result.err).toBe('string');
    expect(result.err.length).toBeGreaterThan(0);
  });

  it('the healing loop throwing partway through is a real failure with the real reason in the error string, not just buried in data', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs({ bodyPartCount: 1, healThrows: true }));
    const result = bridge.callHandler('healPlayer', { username: 'Test' });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/corrupted|failed/i);
  });

  it('a genuine heal (parts really restored) still reports success, unaffected by the fix', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs({ bodyPartCount: 2 }));
    const result = bridge.callHandler('healPlayer', { username: 'Test' });

    expect(result.ok).toBe(true);
    expect(result.data.healed.bodyDamage).toBe(true);
  });

  it('body healing succeeds but network sync is unavailable: still a real success, NOT collapsed into a failure -- the sync gap is a materially different, lesser problem', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs({ bodyPartCount: 1, syncAvailable: false }));
    const result = bridge.callHandler('healPlayer', { username: 'Test' });

    expect(result.ok).toBe(true);
    expect(result.data.healed.bodyDamage).toBe(true);
    expect(result.data.healed.networkSync).toBe(false);
  });
});
