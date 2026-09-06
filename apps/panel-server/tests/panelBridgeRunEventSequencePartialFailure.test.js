import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';


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
FakeClimateManager = {}
function FakeClimateManager:stopWeatherAndThunder() return true end
getClimateManager = function() return FakeClimateManager end
`;

describe('PanelBridge.lua runEventSequence -- ok reflects whether every step actually succeeded', () => {
  it('reports ok=true when every step succeeds (unchanged happy path)', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler('runEventSequence', {
      steps: [
        { kind: 'weather', weatherType: 'stop' },
        { kind: 'weather', weatherType: 'stop' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.data.failedCount).toBe(0);
    expect(result.data.executed).toBe(2);
    expect(result.data.results).toHaveLength(2);
    expect(result.data.results.every((r) => r.success)).toBe(true);
  });

  it('reports ok=false when every step fails -- the exact bug this fixes', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler('runEventSequence', {
      steps: [
        { kind: 'bogus-unsupported-kind' },
        { kind: 'bogus-unsupported-kind' },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.data.failedCount).toBe(2);
    expect(result.data.executed).toBe(2);
    expect(result.data.results).toHaveLength(2);
    expect(result.data.results.every((r) => r.success === false)).toBe(true);
  });

  it('reports ok=false on a PARTIAL failure too -- ok means "no step failed", not "not every step failed"', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const result = bridge.callHandler('runEventSequence', {
      steps: [
        { kind: 'weather', weatherType: 'stop' }, // succeeds
        { kind: 'bogus-unsupported-kind' }, // fails
        { kind: 'weather', weatherType: 'stop' }, // succeeds
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.data.failedCount).toBe(1);
    expect(result.data.executed).toBe(3);
    expect(result.data.results.filter((r) => r.success)).toHaveLength(2);
    expect(result.data.results.filter((r) => !r.success)).toHaveLength(1);
  });
});
