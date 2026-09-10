import { beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());

vi.mock('../utils/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }),
}));

const { PanelBridge } = await import('../services/panelBridge.ts');

beforeEach(() => warn.mockClear());

describe('PanelBridge late results', () => {
  it('logs an orphaned result instead of silently discarding it', () => {
    const bridge = new PanelBridge();

    bridge.processResult({
      id: 'late-command',
      success: true,
      timestamp: Date.now() - 5_000,
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/orphaned result id=late-command success=true/),
    );
  });

  it('does not log for a normal pending result', () => {
    const bridge = new PanelBridge();
    const timeout = setTimeout(() => {}, 10_000);
    bridge.pendingCommands.set('on-time', {
      resolve: vi.fn(),
      reject: vi.fn(),
      timeout,
      action: 'ping',
      timestamp: Date.now(),
    });

    bridge.processResult({ id: 'on-time', success: true, data: {} });

    expect(warn).not.toHaveBeenCalled();
    clearTimeout(timeout);
  });
});
