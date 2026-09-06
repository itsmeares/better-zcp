import { describe, expect, it, vi, beforeEach } from 'vitest';

// Regression, confirmed empirically on a real Windows host (2026-08-23):
// Get-CimInstance Win32_Process | Where-Object { <no match> } | ... |
// ConvertTo-Csv -NoTypeInformation emits NOTHING at all when its input
// pipeline is empty -- not a header row, not a blank line, the literal
// empty string -- because ConvertTo-Csv derives its header from the first
// object it receives. node's exec() then reports psError: null (the
// command ran and exited 0) with psStdout: "". The scan's condition was
// `if (psError || !psStdout)`, which cannot tell "the command genuinely
// failed" apart from "the command ran fine and correctly found zero
// processes" -- both look like an empty psStdout with no error either way
// only in the FAILURE case; here it's an empty stdout with NO error, which
// the old code treated identically to a failure anyway. The practical
// effect: on Windows, a genuinely STOPPED server (zero matching processes,
// which is the expected, correct, successful result) was indistinguishable
// from a broken scan, and every fail-closed guard (`/wipe` included)
// refused forever -- deterministically, on every restart, for every
// Windows install, the moment those guards started respecting scanFailed
// in 1.2.0. This is what a real user (reported via Discord, forwarded by
// the operator) hit.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: (...args) => execFileMock(...args) };
});

const { ServerManager } = await import('../services/serverManager.js');

describe('ServerManager Windows scan: empty match set vs a genuine exec failure', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it.runIf(process.platform === 'win32')(
    'reports a confirmed stop (scanFailed: false), not scanFailed, when PowerShell runs successfully and finds nothing',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        // The real, confirmed shape: no error, exit 0, empty stdout --
        // ConvertTo-Csv on an empty pipeline.
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
      // A command that both errors AND happens to produce no stdout --
      // must not accidentally read as a confirmed stop just because
      // stdout is empty.
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(new Error('timed out'), '', '');
      });

      const manager = new ServerManager();
      const result = await manager._scanDedicatedServerProcesses();

      expect(result.scanFailed).toBe(true);
    },
  );
});

// Regression (2026-08-31 services sweep): the Windows branch had no
// equivalent of the Linux branch's ambiguous-candidate fallback (already
// fixed 2026-08-29 for the identical false-negative shape) -- a real
// dedicated server launched as a generic `java.exe -jar ...` invocation
// that isWindowsDedicatedServerCommandLine doesn't recognize was confidently
// reported not-running instead of scanFailed:true.
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
      // The narrow matcher already requires -server/startserver/-servername
      // for ProjectZomboid64/32.exe specifically because the same binary is
      // the graphical client. An operator playing the game locally on the
      // panel's own host must not flip every scan to "can't confirm
      // stopped" just because the client is open.
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
