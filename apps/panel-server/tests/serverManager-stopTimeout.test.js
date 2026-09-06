import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import { ServerManager } from '../services/serverManager.js';


function makeManager(overrides = {}) {
  const manager = new ServerManager();
  Object.assign(manager, { configLoaded: true, serverName: 'StopTimeoutTest' }, overrides);
  manager._confirmProcessStopped = vi.fn().mockResolvedValue(true);
  return manager;
}

describe('stopServer: kill timeout cannot leave the server permanently stuck', () => {
  it.runIf(process.platform !== 'win32')('also stops the tracked detached launcher process group', async () => {
    const manager = makeManager({
      serverProcess: { pid: 4241, killed: false, exitCode: null },
    });
    manager.getServerProcessDetails = async () => ({
      running: true,
      matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      owned: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      scanFailed: false,
    });
    const groupKill = vi
      .spyOn(manager, '_killProcessGroup')
      .mockReturnValue({ failed: false, errors: [] });
    manager._killPids = async () => ({ timedOut: false });

    await manager.stopServer(false);

    expect(groupKill).toHaveBeenCalledWith(4241);
  });

  it('simulates a kill that never returns on its own: _stopping still clears and the caller is told the confirmation timed out', async () => {
    const manager = makeManager();
    manager.getServerProcessDetails = async () => ({
      running: true,
      matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      owned: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      scanFailed: false,
    });
    manager._killPids = async () => ({ timedOut: true });

    const result = await stopServerWithGuard(manager);

    expect(result.success).toBe(true);
    expect(result.message.toLowerCase()).toContain('timed out');
    expect(manager._stopping).toBe(false);
  });

  it('does the same for the generic (detection-failed) fallback path', async () => {
    const manager = makeManager();
    manager.getServerProcessDetails = async () => ({
      running: false,
      matched: [],
      owned: [],
      scanFailed: true,
    });
    manager._isOnlyLocalServer = async () => true;
    manager._genericForceStop = async () => ({ timedOut: true });

    const result = await stopServerWithGuard(manager);

    expect(result.success).toBe(true);
    expect(result.message.toLowerCase()).toContain('timed out');
    expect(manager._stopping).toBe(false);
  });

  it('regression: a kill that finishes normally still reports plain success, unchanged from before', async () => {
    const manager = makeManager();
    manager.getServerProcessDetails = async () => ({
      running: true,
      matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      owned: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      scanFailed: false,
    });
    manager._killPids = async () => ({ timedOut: false });

    const result = await stopServerWithGuard(manager);

    expect(result).toEqual({ success: true, message: 'Server stopped' });
    expect(manager._stopping).toBe(false);
  });

  it('regression: the generic fallback still reports plain success when it finishes normally', async () => {
    const manager = makeManager();
    manager.getServerProcessDetails = async () => ({
      running: false,
      matched: [],
      owned: [],
      scanFailed: true,
    });
    manager._isOnlyLocalServer = async () => true;
    manager._genericForceStop = async () => ({ timedOut: false });

    const result = await stopServerWithGuard(manager);

    expect(result).toEqual({ success: true, message: 'Forced fallback kill executed' });
    expect(manager._stopping).toBe(false);
  });

  it('does not claim success when the post-kill process scan still sees the server', async () => {
    const manager = makeManager();
    manager.getServerProcessDetails = async () => ({
      running: true,
      matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      owned: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername StopTimeoutTest' }],
      scanFailed: false,
    });
    manager._killPids = async () => ({ timedOut: false });
    manager._confirmProcessStopped = vi.fn().mockResolvedValue(false);

    const result = await stopServerWithGuard(manager);

    expect(result.success).toBe(true);
    expect(result.confirmed).toBe(false);
    expect(result.message).toContain('still running');
    expect(manager._stopping).toBe(false);
  });
});

async function stopServerWithGuard(manager) {
  return Promise.race([
    manager.stopServer(false),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('stopServer() did not return — _stopping would be stuck')), 2000),
    ),
  ]);
}

describe('underlying platform contract: execFile timeout aborts a hung child', () => {
  it.runIf(process.platform === 'win32')(
    'on Windows, a slow command is aborted within the configured timeout and the callback fires with killed=true',
    async () => {
      const err = await new Promise((resolve) => {
        execFile(
          'powershell',
          ['-Command', 'Start-Sleep -Seconds 30'],
          { timeout: 300 },
          (execErr) => resolve(execErr),
        );
      });

      expect(err).toBeTruthy();
      expect(err.killed).toBe(true);
    },
    5000,
  );

  it.runIf(process.platform !== 'win32')(
    'on POSIX, a slow command is aborted within the configured timeout and the callback fires with killed=true',
    async () => {
      const err = await new Promise((resolve) => {
        execFile('sleep', ['30'], { timeout: 300 }, (execErr) => resolve(execErr));
      });

      expect(err).toBeTruthy();
      expect(err.killed).toBe(true);
    },
    5000,
  );
});
