import { describe, expect, it } from 'vitest';
import { ServerManager, scoreServerProcessOwnership } from '../services/serverManager.ts';

describe('ServerManager serverName default identity', () => {
  it('does not default this.serverName to the literal vanilla PZ name "servertest"', () => {
    const manager = new ServerManager();
    expect(manager.serverName).not.toBe('servertest');
  });

  it('reloadConfig does not reset this.serverName back to "servertest" either', async () => {
    const manager = new ServerManager();
    manager.serverName = 'SomeRealServer';
    manager.loadConfig = async () => {};
    await manager.reloadConfig();
    expect(manager.serverName).not.toBe('servertest');
  });

  it('an unconfigured manager does not falsely claim ownership of an unrelated real vanilla-named PZ process', () => {
    const manager = new ServerManager();
    const descriptor = {
      serverName: manager.serverName,
      savePath: '',
      serverPath: '',
    };
    const unrelatedVanillaServerCmd =
      'java zombie.network.GameServer -servername servertest -cachedir="C:\\Zomboid\\SomeoneElses"';
    expect(scoreServerProcessOwnership(unrelatedVanillaServerCmd, descriptor)).toBe(0);
  });
});
