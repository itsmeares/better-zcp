import { describe, it, expect, vi } from 'vitest';
import { PanelBridge } from '../services/panelBridge.js';

// 2026-08-30, panelbridge-total-audit-2026-08-30 (Finding A): processResult's
// failure branch discarded result.data entirely, for all 101 actions -- a
// transport bug, not a handler bug. killPlayer's not-dead path returns no
// error string at all (only data.message), so callers saw the generic
// "Command failed" instead of the handler's own crafted text, and lost
// isDead/debug. teleportPlayer's verify-false path kept its message but lost
// {oldPosition, newPosition, verifyPosition, debug} entirely.

function makePendingBridge(action) {
  const bridge = new PanelBridge();
  const resolve = vi.fn();
  const reject = vi.fn();
  const timeout = setTimeout(() => {}, 10000);
  bridge.pendingCommands.set('cmd-1', { resolve, reject, timeout, action, timestamp: Date.now() });
  return { bridge, resolve, reject };
}

describe('PanelBridge processResult -- failure data preservation', () => {
  it('preserves an existing result.error string unchanged (teleportPlayer shape) and still attaches data', () => {
    const { bridge, reject } = makePendingBridge('teleportPlayer');
    const data = {
      oldPosition: { x: 1, y: 2, z: 0 },
      newPosition: { x: 1, y: 2, z: 0 },
      verifyPosition: { x: 1, y: 2, z: 0 },
      debug: 'teleport did not move',
    };

    bridge.processResult({
      id: 'cmd-1',
      success: false,
      error: 'Teleport call succeeded but the player did not move (verified false)',
      data,
    });

    expect(reject).toHaveBeenCalledTimes(1);
    const err = reject.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Teleport call succeeded but the player did not move (verified false)');
    expect(err.data).toEqual(data);
  });

  it('falls back to data.message when result.error is absent (killPlayer not-dead shape) and attaches data', () => {
    const { bridge, reject } = makePendingBridge('killPlayer');
    const data = {
      message: 'Kill attempted (player may respawn if not dead)',
      username: 'Bob',
      isDead: false,
      debug: { method: 'setHealth' },
    };

    bridge.processResult({
      id: 'cmd-1',
      success: false,
      data,
    });

    expect(reject).toHaveBeenCalledTimes(1);
    const err = reject.mock.calls[0][0];
    expect(err.message).toBe('Kill attempted (player may respawn if not dead)');
    expect(err.data).toEqual(data);
  });

  it('still falls back to the generic "Command failed" string when neither error nor data.message exist', () => {
    const { bridge, reject } = makePendingBridge('someAction');

    bridge.processResult({
      id: 'cmd-1',
      success: false,
      data: { foo: 'bar' },
    });

    expect(reject).toHaveBeenCalledTimes(1);
    const err = reject.mock.calls[0][0];
    expect(err.message).toBe('Command failed');
    expect(err.data).toEqual({ foo: 'bar' });
  });

  it('does not attach data or change resolve behavior on success', () => {
    const { bridge, resolve, reject } = makePendingBridge('ping');

    bridge.processResult({ id: 'cmd-1', success: true, data: { alive: true } });

    expect(resolve).toHaveBeenCalledWith({ success: true, data: { alive: true } });
    expect(reject).not.toHaveBeenCalled();
  });
});
