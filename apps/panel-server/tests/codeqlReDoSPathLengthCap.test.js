import { describe, expect, it } from 'vitest';
import { validateRemoteConfigTransport } from '../services/remoteConfigFiles.js';
import { validateSftpBridgeConfig } from '../services/panelBridgeSftp.js';

// CodeQL js/polynomial-redos #3 and #1: safeRemoteDir()/safeRemotePath()'s
// trailing-slash trim (`/\/+$/`) is quadratic on a crafted string. Both
// validators must reject an oversized path outright, before the regex ever
// runs, rather than accepting it and hanging the event loop.
describe('remote/bridge path length cap (CodeQL js/polynomial-redos #3, #1)', () => {
  it('validateRemoteConfigTransport rejects an oversized configPath', () => {
    const overlong = '/' + 'a'.repeat(600);
    expect(() =>
      validateRemoteConfigTransport({
        host: 'pz.example.net',
        username: 'panel',
        configPath: overlong,
      }),
    ).toThrow();
  });

  it('validateRemoteConfigTransport still accepts a normal-length configPath', () => {
    const result = validateRemoteConfigTransport({
      host: 'pz.example.net',
      username: 'panel',
      configPath: '/home/pz/Server',
    });
    expect(result.configPath).toBe('/home/pz/Server');
  });

  it('validateSftpBridgeConfig rejects an oversized bridgePath', () => {
    const overlong = '/' + 'a'.repeat(600);
    expect(() =>
      validateSftpBridgeConfig({
        host: 'pz.example.net',
        username: 'panel',
        bridgePath: overlong,
      }),
    ).toThrow();
  });

  it('validateSftpBridgeConfig still accepts a normal-length bridgePath', () => {
    const result = validateSftpBridgeConfig({
      host: 'pz.example.net',
      username: 'panel',
      bridgePath: '/home/pz/Zomboid/Lua',
    });
    expect(result.bridgePath).toBe('/home/pz/Zomboid/Lua');
  });
});
