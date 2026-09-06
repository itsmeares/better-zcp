import { describe, expect, it } from 'vitest';
import { validateRemoteConfigTransport } from '../services/remoteConfigFiles.ts';
import { validateSftpBridgeConfig } from '../services/panelBridgeSftp.js';

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
