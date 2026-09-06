import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { ServerManager } from '../services/serverManager.js';

// Covers the pidfile fast path added to getServerProcessDetails(): it must
// only ever short-circuit the full OS scan when there is zero doubt about
// which process it's looking at, and fall through to the existing,
// already-tested scan on any doubt at all (missing pidfile, dead PID, or a
// live PID whose command line no longer matches — including PID reuse by
// an unrelated process).

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
    // No _writePidFile call -- pidfile is missing.
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
    manager._getLiveCommandLine = async () => null; // PID not alive.
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
    // PID 7777 is alive, but it's now an unrelated process -- reused since
    // the pidfile was written. This is the case the design exists to guard
    // against: trusting a stale pidfile here would be a confident wrong
    // "running" (or "not running") answer, which is worse than a slow
    // correct one.
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
    // Still a real PZ dedicated-server process, but -servername proves it
    // is NOT this manager's server -- another reuse-adjacent case: the PID
    // could have been recycled into a different configured server's process.
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
    // 2026-09-04, overnight bug hunt: scoreServerProcessOwnership() returns
    // 0 (not -1) for a live PZ-looking process whose command line has
    // neither -servername nor -cachedir, or whose install path doesn't
    // appear in it either -- e.g. another operator's server on the same
    // host, launched from a stock/vanilla StartServer64.bat with no
    // identifying args. The full scan (getServerProcessDetails' non-fast
    // path below) only trusts a score-0 "unattributable" candidate when
    // NOTHING else on the host positively matched -- a comparison this
    // single-PID lookup structurally cannot make, since it only ever looks
    // at the one recorded PID. Before this fix, checking `score === -1`
    // (instead of `score <= 0`) meant a reused PID landing on exactly this
    // kind of unrelated, unidentifiable server process was wrongly
    // confirmed as running by the fast path, even though the full scan
    // would never have that confidence for the same command line without
    // first checking there was no better-attributed alternative.
    manager._writePidFile(3131);
    manager._getLiveCommandLine = async () =>
      'java zombie.network.GameServer'; // no -servername, no -cachedir, no install path
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
    manager._getLiveCommandLine = async () => null; // lookup failure is indistinguishable from "not alive" by design
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
