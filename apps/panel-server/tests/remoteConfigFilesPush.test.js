import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// getMirrorPath/pullRemoteConfigFiles read getDataPaths().dataDir -- mocked
// to a disposable temp dir per the same pattern panelBridgeSftp.test.js uses,
// so the mirror files this test writes never touch the real data directory.
const mockDataPaths = vi.hoisted(() => {
  const base = (process.env.TEMP || process.env.TMPDIR || '/tmp') + '/remote-config-push-test';
  return { dataDir: base + '/data', logsDir: base + '/logs' };
});
vi.mock('../utils/paths.js', () => ({ getDataPaths: () => mockDataPaths }));

// ssh2-sftp-client is mocked entirely -- these tests are about the ORDER of
// calls pushRemoteConfigFiles makes (posixRename first, delete+rename only
// as a fallback), not about a real SFTP transport.
const sftpInstances = vi.hoisted(() => ({ current: [] }));
vi.mock('ssh2-sftp-client', () => {
  return {
    // A plain `function`, not an arrow function -- vi.fn() calls this via
    // `new SftpClient(...)` in the real module, and arrow functions cannot
    // be used as constructors.
    default: vi.fn().mockImplementation(function () {
      const instance = {
        connect: vi.fn().mockResolvedValue(undefined),
        end: vi.fn().mockResolvedValue(undefined),
        put: vi.fn().mockResolvedValue(undefined),
        posixRename: vi.fn().mockResolvedValue('ok'),
        rename: vi.fn().mockResolvedValue('ok'),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      sftpInstances.current.push(instance);
      return instance;
    }),
  };
});

const { pushRemoteConfigFiles } = await import('../services/remoteConfigFiles.js');

const config = {
  host: 'pz.example.net',
  port: 22,
  username: 'panel',
  password: 'secret',
  configPath: '/home/pz/Server',
};

const temporaryDirectories = [];

afterEach(() => {
  vi.clearAllMocks();
  sftpInstances.current = [];
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeMirrorSession(serverName, fileContent) {
  const mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-config-mirror-'));
  temporaryDirectories.push(mirrorDir);
  const fileName = `${serverName}.ini`;
  fs.writeFileSync(path.join(mirrorDir, fileName), fileContent, 'utf-8');
  // manifest intentionally omits the file (or gives it a different hash) so
  // pushRemoteConfigFiles treats it as changed and something to push.
  return { mirrorDir, manifest: {} };
}

describe('pushRemoteConfigFiles remote replace safety', () => {
  it('uses posixRename (atomic replace) and never calls delete/rename when it succeeds', async () => {
    const session = makeMirrorSession('servertest', 'ModOptions=1\n');

    const result = await pushRemoteConfigFiles(config, 'servertest', session);

    expect(result.pushed).toEqual(['servertest.ini']);
    const client = sftpInstances.current[0];
    expect(client.posixRename).toHaveBeenCalledTimes(1);
    expect(client.posixRename).toHaveBeenCalledWith(
      '/home/pz/Server/servertest.ini.panel-tmp',
      '/home/pz/Server/servertest.ini',
    );
    expect(client.delete).not.toHaveBeenCalled();
    expect(client.rename).not.toHaveBeenCalled();
  });

  it('falls back to delete-then-rename only when posixRename is unsupported', async () => {
    const session = makeMirrorSession('servertest', 'ModOptions=2\n');

    // Simulate an SFTP server old enough to lack posix-rename@openssh.com.
    const originalClientCtor = (await import('ssh2-sftp-client')).default;
    originalClientCtor.mockImplementationOnce(function () {
      const instance = {
        connect: vi.fn().mockResolvedValue(undefined),
        end: vi.fn().mockResolvedValue(undefined),
        put: vi.fn().mockResolvedValue(undefined),
        posixRename: vi.fn().mockRejectedValue(new Error('Unsupported extension')),
        rename: vi.fn().mockResolvedValue('ok'),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      sftpInstances.current.push(instance);
      return instance;
    });

    const result = await pushRemoteConfigFiles(config, 'servertest', session);

    expect(result.pushed).toEqual(['servertest.ini']);
    const client = sftpInstances.current[0];
    expect(client.posixRename).toHaveBeenCalledTimes(1);
    expect(client.delete).toHaveBeenCalledWith('/home/pz/Server/servertest.ini');
    expect(client.rename).toHaveBeenCalledWith(
      '/home/pz/Server/servertest.ini.panel-tmp',
      '/home/pz/Server/servertest.ini',
    );
  });

  it('tolerates delete failing on a file that does not exist remotely yet, in the fallback path', async () => {
    const session = makeMirrorSession('servertest', 'ModOptions=3\n');

    const originalClientCtor = (await import('ssh2-sftp-client')).default;
    originalClientCtor.mockImplementationOnce(function () {
      const instance = {
        connect: vi.fn().mockResolvedValue(undefined),
        end: vi.fn().mockResolvedValue(undefined),
        put: vi.fn().mockResolvedValue(undefined),
        posixRename: vi.fn().mockRejectedValue(new Error('Unsupported extension')),
        rename: vi.fn().mockResolvedValue('ok'),
        delete: vi.fn().mockRejectedValue(new Error('No such file')),
      };
      sftpInstances.current.push(instance);
      return instance;
    });

    const result = await pushRemoteConfigFiles(config, 'servertest', session);

    expect(result.pushed).toEqual(['servertest.ini']);
    const client = sftpInstances.current[0];
    expect(client.rename).toHaveBeenCalledTimes(1);
  });
});
