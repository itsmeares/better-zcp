import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockDataPaths = vi.hoisted(() => {
  const base = (process.env.TEMP || process.env.TMPDIR || '/tmp') + '/panel-bridge-sftp-queuestate-test-default';
  return { current: () => ({ dataDir: base + '/data', logsDir: base + '/logs' }) };
});
vi.mock('../utils/paths.ts', () => ({ getDataPaths: (...args) => mockDataPaths.current(...args) }));

const { PanelBridgeSftpTransport, validateSftpBridgeConfig } = await import('../services/panelBridgeSftp.js');

const valid = {
  host: 'pz.example.net',
  port: 22,
  username: 'panelbridge',
  password: 'not-a-real-secret',
  bridgePath: '/home/pz/Zomboid/Lua/panelbridge/TestServer',
  pollIntervalSeconds: 3,
};

const temporaryDirectories = [];

afterEach(() => {
  for (const temporaryDirectory of temporaryDirectories.splice(0)) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

function makeTempCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-sftp-queuestate-test-'));
  temporaryDirectories.push(dir);
  fs.mkdirSync(path.join(dir, 'inbox'));
  return dir;
}

describe('readLocalQueueStateNodeSnapshot', () => {
  it('returns null when cachePath has not been set yet', () => {
    const transport = new PanelBridgeSftpTransport();
    expect(transport.readLocalQueueStateNodeSnapshot()).toBeNull();
  });

  it('returns null when no queue-state-node.json has been persisted yet', () => {
    const transport = new PanelBridgeSftpTransport();
    transport.cachePath = makeTempCache();
    expect(transport.readLocalQueueStateNodeSnapshot()).toBeNull();
  });

  it('returns null (not a throw) when the file is present but unparsable', () => {
    const transport = new PanelBridgeSftpTransport();
    transport.cachePath = makeTempCache();
    fs.writeFileSync(path.join(transport.cachePath, '.queue-state-node.json'), 'not-json');
    expect(transport.readLocalQueueStateNodeSnapshot()).toBeNull();
  });

  it('returns the parsed value when the file is present and well-formed', () => {
    const transport = new PanelBridgeSftpTransport();
    transport.cachePath = makeTempCache();
    const state = { protocolVersion: 'queue-v1', nextCommandSeq: 7, lastConsumedResultSeq: 2 };
    fs.writeFileSync(path.join(transport.cachePath, '.queue-state-node.json'), JSON.stringify(state));
    expect(transport.readLocalQueueStateNodeSnapshot()).toEqual(state);
  });
});

describe('uploadQueueStateNode', () => {
  it('uploads the snapshot to a temporary remote name before publishing it', async () => {
    const put = vi.fn(async () => {});
    const rename = vi.fn(async () => {});
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.transferId = 'test-transfer';
    transport.client = { exists: vi.fn(async () => false), put, rename, delete: vi.fn(async () => {}) };

    await transport.uploadQueueStateNode({ nextCommandSeq: 3, lastConsumedResultSeq: 1 });

    const remotePath = `${valid.bridgePath}/.queue-state-node.json`;
    expect(put).toHaveBeenCalledTimes(1);
    const [uploadedSource, uploadedRemotePath] = put.mock.calls[0];
    expect(uploadedRemotePath).toBe(`${remotePath}.test-transfer.uploading`);
    expect(Buffer.isBuffer(uploadedSource)).toBe(true);
    expect(JSON.parse(uploadedSource.toString('utf8'))).toEqual({ nextCommandSeq: 3, lastConsumedResultSeq: 1 });
    expect(rename).toHaveBeenCalledWith(`${remotePath}.test-transfer.uploading`, remotePath);
  });

  it('removes a partial remote queue-state file when the upload fails', async () => {
    const deleteRemote = vi.fn(async () => {});
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.transferId = 'failed-transfer';
    transport.client = {
      exists: vi.fn(async () => false),
      put: vi.fn(async () => { throw new Error('Connection reset'); }),
      rename: vi.fn(async () => {}),
      delete: deleteRemote,
    };

    await expect(transport.uploadQueueStateNode({ nextCommandSeq: 1 })).rejects.toThrow('Connection reset');
    expect(deleteRemote).toHaveBeenCalledWith(
      `${valid.bridgePath}/.queue-state-node.json.failed-transfer.uploading`,
    );
  });

  it('refuses to treat a remote directory as the queue-state file', async () => {
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.client = { exists: vi.fn(async () => 'd') };

    await expect(transport.uploadQueueStateNode({ nextCommandSeq: 1 })).rejects.toThrow('occupied by a directory');
  });
});

describe('syncNow: queue-state upload ordering', () => {
  it('does not attempt to upload the queue-state file when nothing has been persisted locally yet', async () => {
    const put = vi.fn(async () => {});
    const transport = new PanelBridgeSftpTransport();
    transport.running = true;
    transport.config = validateSftpBridgeConfig(valid);
    transport.cachePath = makeTempCache();
    transport.client = { put };
    transport.ensureRemoteDirectories = vi.fn(async () => {});
    transport.uploadInbox = vi.fn(async () => {});
    transport.syncModFile = vi.fn(async () => {});
    transport.syncOutbox = vi.fn(async () => {});

    await transport.syncNow();

    expect(put).not.toHaveBeenCalled();
  });

  it('uploads the queue-state snapshot captured before uploadInbox() runs, never a value that advanced during it', async () => {
    const transport = new PanelBridgeSftpTransport();
    transport.running = true;
    transport.config = validateSftpBridgeConfig(valid);
    transport.cachePath = makeTempCache();
    const statePath = path.join(transport.cachePath, '.queue-state-node.json');
    fs.writeFileSync(statePath, JSON.stringify({ nextCommandSeq: 5, lastConsumedResultSeq: 0 }));

    const put = vi.fn(async () => {});
    const rename = vi.fn(async () => {});
    transport.client = { exists: vi.fn(async () => false), put, rename, delete: vi.fn(async () => {}) };
    transport.ensureRemoteDirectories = vi.fn(async () => {});
    transport.syncModFile = vi.fn(async () => {});
    transport.syncOutbox = vi.fn(async () => {});
    transport.uploadInbox = vi.fn(async () => {
      fs.writeFileSync(statePath, JSON.stringify({ nextCommandSeq: 999, lastConsumedResultSeq: 0 }));
    });

    await transport.syncNow();

    expect(put).toHaveBeenCalledTimes(1);
    const uploadedSource = put.mock.calls[0][0];
    expect(JSON.parse(uploadedSource.toString('utf8'))).toEqual({ nextCommandSeq: 5, lastConsumedResultSeq: 0 });
  });
});
