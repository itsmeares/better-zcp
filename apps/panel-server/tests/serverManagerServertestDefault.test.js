import { describe, expect, it } from 'vitest';
import { ServerManager, scoreServerProcessOwnership } from '../services/serverManager.js';

// Before any real config has been loaded (e.g. a freshly-constructed
// singleton, or after reloadConfig() resets state ahead of an async
// loadConfig()), ServerManager must not claim the literal identity
// "servertest" -- that is Project Zomboid's own vanilla default server
// name, so an unconfigured panel instance defaulting to it collides with
// any real, unrelated dedicated server a user happens to be running under
// that name. Same fake-identity class already fixed at the route and
// persistence layers (apps/panel-server/routes/servers.js, 169907a).
describe('ServerManager serverName default identity', () => {
  it('does not default this.serverName to the literal vanilla PZ name "servertest"', () => {
    const manager = new ServerManager();
    expect(manager.serverName).not.toBe('servertest');
  });

  it('reloadConfig does not reset this.serverName back to "servertest" either', async () => {
    const manager = new ServerManager();
    manager.serverName = 'SomeRealServer';
    // Stub loadConfig so reloadConfig's own reset assignment is observable,
    // isolated from whatever loadConfig() would otherwise resolve.
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
    // A definitive (>0) score here means the manager believes this PID is
    // ITS server purely because both happen to be named "servertest" --
    // score 0 ("unattributable") is the correct, honest answer when this
    // instance has no configured identity of its own yet.
    expect(scoreServerProcessOwnership(unrelatedVanillaServerCmd, descriptor)).toBe(0);
  });
});
