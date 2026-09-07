import { describe, expect, it, vi, beforeEach } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: (...args) => execFileMock(...args) };
});

const { ServerManager } = await import('../services/serverManager.ts');

describe('ServerManager Windows scan: empty match set vs a genuine exec failure', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it.runIf(process.platform === 'win32')(
    'reports a confirmed stop (scanFailed: false), not scanFailed, when PowerShell runs successfully and finds nothing',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(null, '', '');
      });

      const manager = new ServerManager();
      const result = await manager._scanDedicatedServerProcesses();

      expect(result.scanFailed).toBeFalsy();
      expect(result.running).toBe(false);
      expect(result.matched).toEqual([]);
      expect(execFileMock).toHaveBeenCalledWith(
        expect.stringMatching(/powershell\.exe$/i),
        expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']),
        { timeout: 8000 },
        expect.any(Function),
      );
    },
  );

  it.runIf(process.platform === 'win32')(
    'still reports scanFailed when the shell-out genuinely errors',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(new Error('powershell.exe is not recognized'), '', 'not recognized');
      });

      const manager = new ServerManager();
      const result = await manager._scanDedicatedServerProcesses();

      expect(result.scanFailed).toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')(
    'fails closed when PowerShell reports diagnostics despite a zero exit code',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(null, '', 'Get-CimInstance : Access is denied');
      });

      const manager = new ServerManager();
      const result = await manager._scanDedicatedServerProcesses();

      expect(result.scanFailed).toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')(
    'still reports scanFailed on empty output when psError is set (belt and suspenders)',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(new Error('timed out'), '', '');
      });

      const manager = new ServerManager();
      const result = await manager._scanDedicatedServerProcesses();

      expect(result.scanFailed).toBe(true);
    },
  );
});

function csv(rows) {
  const header = '"ProcessId","CommandLine"';
  const lines = rows.map(
    ([pid, cmd]) => `"${pid}","${String(cmd).replace(/"/g, '""')}"`,
  );
  return [header, ...lines].join('\r\n');
}

describe('ServerManager Windows scan: ambiguous JVM-shaped candidates', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it.runIf(process.platform === 'win32')(
    'reports scanFailed for a java.exe candidate that mentions zomboid but does not match the narrow launch pattern',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(
          null,
          csv([
            [
              '4242',
              String.raw`"C:\Java\java.exe" -Xmx4G -cp "C:\PZServer\zomboid-dedicated.jar"`,
            ],
          ]),
          '',
        );
      });

      const manager = new ServerManager();
      const result = await manager._scanDedicatedServerProcesses();

      expect(result.scanFailed).toBe(true);
      expect(result.running).toBe(false);
      expect(result.matched).toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not flag an unrelated java.exe application (no zomboid mention) as ambiguous',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(
          null,
          csv([
            [
              '4243',
              String.raw`"C:\Program Files\Jenkins\jre\bin\java.exe" -jar jenkins.war`,
            ],
          ]),
          '',
        );
      });

      const manager = new ServerManager();
      const result = await manager._scanDedicatedServerProcesses();

      expect(result.scanFailed).toBeFalsy();
      expect(result.running).toBe(false);
      expect(result.matched).toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not flag a plain ProjectZomboid64.exe client launch (no server flags) as ambiguous',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(
          null,
          csv([
            ['4244', String.raw`"C:\Games\ProjectZomboid\ProjectZomboid64.exe"`],
          ]),
          '',
        );
      });

      const manager = new ServerManager();
      const result = await manager._scanDedicatedServerProcesses();

      expect(result.scanFailed).toBeFalsy();
      expect(result.running).toBe(false);
      expect(result.matched).toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'still confirms a recognized dedicated-server launch as running, unaffected by the new ambiguous bucket',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(
          null,
          csv([
            [
              '4245',
              String.raw`"C:\Java\java.exe" zombie.network.GameServer -servername test`,
            ],
          ]),
          '',
        );
      });

      const manager = new ServerManager();
      const result = await manager._scanDedicatedServerProcesses();

      expect(result.scanFailed).toBeFalsy();
      expect(result.running).toBe(true);
      expect(result.matched).toHaveLength(1);
    },
  );
});
