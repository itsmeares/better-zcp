import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { ServerManager } from '../services/serverManager.js';


describe('ServerManager pidfile fast path', () => {
  let manager;

  beforeEach(() => {
    manager = new ServerManager();
    Object.assign(manager, { configLoaded: true, serverName: 'PidTestServer' });
  });

  afterEach(() => {
    try {
      fs.unlinkSync(manager._pidFilePath());
    } catch {
      /* nothing to clean up */
    }
  });

  it('hits the fast path and skips the OS scan when the pidfile is valid and the cmdline still matches', async () => {
    manager._writePidFile(4242);
    manager._getLiveCommandLine = async (pid) => {
      expect(String(pid)).toBe('4242');
      return 'java -cp pz.jar zombie.network.GameServer -servername PidTestServer';
    };
    let scanCalled = false;
    manager._scanDedicatedServerProcesses = async () => {
      scanCalled = true;
      return { running: false, matched: [] };
    };

    const details = await manager.getServerProcessDetails();

    expect(details.running).toBe(true);
    expect(details.owned.map((entry) => entry.pid)).toEqual(['4242']);
    expect(scanCalled).toBe(false);
  });

  it('falls back to the OS scan when there is no pidfile', async () => {
    manager._getLiveCommandLine = async () => {
      throw new Error('should not be called when there is no pidfile');
    };
    let scanCalled = false;
    manager._scanDedicatedServerProcesses = async () => {
      scanCalled = true;
      return { running: false, matched: [] };
    };

    const details = await manager.getServerProcessDetails();

    expect(scanCalled).toBe(true);
    expect(details.running).toBe(false);
  });

  it('falls back to the OS scan when the recorded PID is dead', async () => {
    manager._writePidFile(9999);
    manager._getLiveCommandLine = async () => null;
    let scanCalled = false;
    manager._scanDedicatedServerProcesses = async () => {
      scanCalled = true;
      return {
        running: true,
        matched: [
          {
            pid: '5555',
            cmd: 'java zombie.network.GameServer -servername PidTestServer',
          },
        ],
      };
    };

    const details = await manager.getServerProcessDetails();

    expect(scanCalled).toBe(true);
    expect(details.running).toBe(true);
    expect(details.owned.map((entry) => entry.pid)).toEqual(['5555']);
  });

  it('falls back to the OS scan when the PID is alive but its cmdline no longer looks like a dedicated server (PID reuse)', async () => {
    manager._writePidFile(7777);
    manager._getLiveCommandLine = async () => 'notepad.exe C:\\Users\\me\\notes.txt';
    let scanCalled = false;
    manager._scanDedicatedServerProcesses = async () => {
      scanCalled = true;
      return { running: false, matched: [] };
    };

    const details = await manager.getServerProcessDetails();

    expect(scanCalled).toBe(true);
    expect(details.running).toBe(false);
  });

  it('falls back to the OS scan when the PID is alive with a dedicated-server cmdline that belongs to a different server', async () => {
    manager._writePidFile(8888);
    manager._getLiveCommandLine = async () =>
      'java zombie.network.GameServer -servername SomeOtherServer -cachedir="C:\\Zomboid\\Other"';
    let scanCalled = false;
    manager._scanDedicatedServerProcesses = async () => {
      scanCalled = true;
      return { running: false, matched: [] };
    };

    const details = await manager.getServerProcessDetails();

    expect(scanCalled).toBe(true);
    expect(details.running).toBe(false);
  });

  it('falls back to the OS scan when the PID is alive with a dedicated-server cmdline that carries no identifying info at all (score 0, unattributable) -- weaker evidence than the fast path may trust', async () => {
    manager._writePidFile(3131);
    manager._getLiveCommandLine = async () =>
      'java zombie.network.GameServer';
    let scanCalled = false;
    manager._scanDedicatedServerProcesses = async () => {
      scanCalled = true;
      return { running: false, matched: [] };
    };

    const details = await manager.getServerProcessDetails();

    expect(scanCalled).toBe(true);
    expect(details.running).toBe(false);
  });

  it('falls back to the OS scan when the live command-line lookup itself fails or times out', async () => {
    manager._writePidFile(6161);
    manager._getLiveCommandLine = async () => null;
    let scanCalled = false;
    manager._scanDedicatedServerProcesses = async () => {
      scanCalled = true;
      return { running: false, matched: [] };
    };

    const details = await manager.getServerProcessDetails();

    expect(scanCalled).toBe(true);
    expect(details.running).toBe(false);
  });

  it('writes a valid pidfile on demand and deletes it when run state is cleared', () => {
    const pidPath = manager._pidFilePath();

    manager._writePidFile(1234);
    expect(fs.existsSync(pidPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(pidPath, 'utf-8'));
    expect(written.pid).toBe('1234');
    expect(written.serverName).toBe('PidTestServer');

    manager._clearRunState();

    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it('scopes the pidfile by server name so two servers do not clobber each other', () => {
    const managerA = new ServerManager();
    Object.assign(managerA, { configLoaded: true, serverName: 'ServerAlpha' });
    const managerB = new ServerManager();
    Object.assign(managerB, { configLoaded: true, serverName: 'ServerBeta' });

    try {
      managerA._writePidFile(111);
      managerB._writePidFile(222);

      expect(managerA._pidFilePath()).not.toBe(managerB._pidFilePath());
      expect(JSON.parse(fs.readFileSync(managerA._pidFilePath(), 'utf-8')).pid).toBe('111');
      expect(JSON.parse(fs.readFileSync(managerB._pidFilePath(), 'utf-8')).pid).toBe('222');
    } finally {
      try {
        fs.unlinkSync(managerA._pidFilePath());
      } catch { /* best-effort cleanup; the file may already be gone */ }
      try {
        fs.unlinkSync(managerB._pidFilePath());
      } catch { /* best-effort cleanup; the file may already be gone */ }
    }
  });
});
