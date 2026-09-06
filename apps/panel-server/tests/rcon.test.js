import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RconService } from '../services/rcon.js';
import { PacketReader } from '../utils/sourceRcon.js';

describe('RCON packet framing', () => {
  const packet = (id, type, body) => {
    const bodyBuf = Buffer.from(body, 'utf8');
    const buf = Buffer.alloc(4 + 4 + 4 + bodyBuf.length + 2);
    buf.writeInt32LE(4 + 4 + bodyBuf.length + 2, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    bodyBuf.copy(buf, 12);
    return buf;
  };

  it('reads a well-formed packet', () => {
    const [pkt] = new PacketReader().push(packet(7, 0, 'hello'));
    expect(pkt).toEqual({ id: 7, type: 0, body: 'hello' });
  });

  it('discards an undersized length header instead of reading out of bounds', () => {
    const buf = Buffer.alloc(5);
    buf.writeInt32LE(1, 0);
    const reader = new PacketReader();
    expect(() => reader.push(buf)).not.toThrow();
    expect(reader.push(buf)).toEqual([]);
  });
});

describe('RCON connection logging', () => {
  it('uses a five-minute cooldown for repeated offline warnings', () => {
    const service = new RconService();

    expect(service.connectionErrorLogCooldown).toBe(5 * 60 * 1000);
  });
});


class MockRconService extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.connecting = false;
    this.serverStarting = false;
    this.consecutiveHealthFailures = 0;
    this.maxHealthFailures = 3;
    this.lastSuccessfulCommand = null;
    this.commandTimeout = 10000;
    this.client = null;
  }

  async execute(command, { skipLog = false } = {}) {
    if (this.serverStarting) {
      return { success: false, error: 'Server is starting, please wait...' };
    }
    if (!this.connected) {
      return { success: false, error: 'Not connected' };
    }

    this.lastSuccessfulCommand = Date.now();
    this.consecutiveHealthFailures = 0;
    return { success: true, response: `Executed: ${command}` };
  }

  simulateHealthCheckFailure() {
    this.consecutiveHealthFailures++;
    if (this.consecutiveHealthFailures >= this.maxHealthFailures) {
      this.connected = false;
      this.consecutiveHealthFailures = 0;
    }
  }
}

describe('RconService', () => {
  let rcon;

  beforeEach(() => {
    rcon = new MockRconService();
  });

  describe('credential sources', () => {
    it('loads RCON_PASSWORD from a Docker secret file', () => {
      const secretPath = path.join(os.tmpdir(), `rcon-secret-${Date.now()}`);
      fs.writeFileSync(secretPath, 'secret-password\n');
      const previous = process.env.RCON_PASSWORD_FILE;
      process.env.RCON_PASSWORD_FILE = secretPath;

      try {
        expect(new RconService().config.password).toBe('secret-password');
      } finally {
        if (previous === undefined) delete process.env.RCON_PASSWORD_FILE;
        else process.env.RCON_PASSWORD_FILE = previous;
        fs.rmSync(secretPath, { force: true });
      }
    });
  });

  describe('execute', () => {
    it('can return a lifecycle command failure without entering reconnect', async () => {
      const liveRcon = new RconService();
      const client = {
        execute: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
        disconnect: vi.fn(),
      };
      liveRcon.client = client;
      liveRcon.connected = true;
      const reconnectSpy = vi.spyOn(liveRcon, 'reconnect');

      const result = await liveRcon.save({
        skipLog: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection was reset');
      expect(reconnectSpy).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    });

    it('cleans up the replacement client when an explicitly retried command fails again', async () => {
      const liveRcon = new RconService();
      const replacement = {
        execute: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
        disconnect: vi.fn(),
      };
      const original = {
        execute: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
        disconnect: vi.fn(),
      };
      liveRcon.client = original;
      liveRcon.connected = true;
      liveRcon.reconnect = vi.fn(async () => {
        liveRcon.client = replacement;
        liveRcon.connected = true;
        return true;
      });

      const result = await liveRcon.save({
        skipLog: true,
        retryOnConnectionError: true,
      });

      expect(result.success).toBe(false);
      expect(liveRcon.connected).toBe(false);
      expect(liveRcon.client).toBeNull();
      expect(replacement.disconnect).toHaveBeenCalledTimes(1);
    });

    it('does not let an old reconnect clear a newer reconnect mutex', async () => {
      const liveRcon = new RconService();
      const deferred = () => {
        let resolve;
        const promise = new Promise((r) => {
          resolve = r;
        });
        return { promise, resolve };
      };
      const first = deferred();
      const second = deferred();
      let call = 0;
      liveRcon._doReconnect = () => (call++ === 0 ? first.promise : second.promise);

      const firstCall = liveRcon.reconnect();
      await Promise.resolve();
      liveRcon.forceResetConnectionState();
      const secondCall = liveRcon.reconnect();

      expect(liveRcon.reconnectPromise).toBe(second.promise);
      first.resolve(false);
      await firstCall;
      expect(liveRcon.reconnecting).toBe(true);
      expect(liveRcon.reconnectPromise).toBe(second.promise);

      second.resolve(false);
      await secondCall;
      expect(liveRcon.reconnecting).toBe(false);
      expect(liveRcon.reconnectPromise).toBeNull();
    });

    it('does not let an old connection failure clear a newer connection generation', async () => {
      const liveRcon = new RconService();
      const oldAttempt = new Error('ECONNRESET');
      let rejectTarget;
      liveRcon.hasConfiguredTarget = vi.fn(
        () =>
          new Promise((_, reject) => {
            rejectTarget = reject;
          }),
      );

      const oldConnect = liveRcon.connect();
      await Promise.resolve();
      liveRcon.forceResetConnectionState();
      const replacement = { disconnect: vi.fn() };
      liveRcon.client = replacement;
      liveRcon.connected = true;
      rejectTarget(oldAttempt);
      await expect(oldConnect).rejects.toThrow('ECONNRESET');

      expect(liveRcon.connected).toBe(true);
      expect(liveRcon.client).toBe(replacement);
      expect(replacement.disconnect).not.toHaveBeenCalled();
    });

    it('should return error when server is starting', async () => {
      rcon.serverStarting = true;
      const result = await rcon.execute('players');
      expect(result.success).toBe(false);
      expect(result.error).toContain('starting');
    });

    it('should return error when not connected', async () => {
      rcon.connected = false;
      const result = await rcon.execute('players');
      expect(result.success).toBe(false);
    });

    it('should succeed when connected', async () => {
      rcon.connected = true;
      const result = await rcon.execute('players');
      expect(result.success).toBe(true);
      expect(result.response).toContain('players');
    });

    it('should reset consecutiveHealthFailures on successful command', async () => {
      rcon.connected = true;
      rcon.consecutiveHealthFailures = 2;
      await rcon.execute('players');
      expect(rcon.consecutiveHealthFailures).toBe(0);
    });

    it('should update lastSuccessfulCommand timestamp', async () => {
      rcon.connected = true;
      const before = Date.now();
      await rcon.execute('players');
      expect(rcon.lastSuccessfulCommand).toBeGreaterThanOrEqual(before);
    });
  });

  describe('health check', () => {
    it('does not let a stale health callback report success after the client changes', async () => {
      const liveRcon = new RconService();
      let resolveHealth;
      const original = {
        execute: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveHealth = resolve;
            }),
        ),
        disconnect: vi.fn(),
      };
      const replacement = { disconnect: vi.fn() };
      liveRcon.client = original;
      liveRcon.connected = true;

      const healthPromise = liveRcon.healthCheck();
      await Promise.resolve();
      liveRcon.client = replacement;
      resolveHealth("Players connected (0)");

      await expect(healthPromise).resolves.toEqual({
        healthy: false,
        reason: "Connection changed",
      });
      expect(original.disconnect).not.toHaveBeenCalled();
      expect(replacement.disconnect).not.toHaveBeenCalled();
    });

    it('should disconnect after max consecutive failures', () => {
      rcon.connected = true;
      rcon.simulateHealthCheckFailure();
      expect(rcon.connected).toBe(true);
      rcon.simulateHealthCheckFailure();
      expect(rcon.connected).toBe(true);
      rcon.simulateHealthCheckFailure();
      expect(rcon.connected).toBe(false);
    });

    it('should not disconnect before max failures', () => {
      rcon.connected = true;
      rcon.simulateHealthCheckFailure();
      rcon.simulateHealthCheckFailure();
      expect(rcon.connected).toBe(true);
      expect(rcon.consecutiveHealthFailures).toBe(2);
    });

    it('successful command should prevent health check disconnect', async () => {
      rcon.connected = true;
      rcon.simulateHealthCheckFailure();
      rcon.simulateHealthCheckFailure();
      await rcon.execute('players');
      rcon.simulateHealthCheckFailure();
      rcon.simulateHealthCheckFailure();
      expect(rcon.connected).toBe(true);
    });
  });

  describe('auto reconnect', () => {
    it('should still probe RCON when process detection says server is not running', async () => {
      vi.useFakeTimers();

      const liveRcon = new RconService();
      const checkServerRunning = vi.fn().mockResolvedValue(false);
      const connectSpy = vi.spyOn(liveRcon, 'connect').mockResolvedValue(false);

      liveRcon.setServerManager({ checkServerRunning });
      liveRcon.startAutoReconnect();

      await vi.advanceTimersByTimeAsync(liveRcon.autoReconnectDelay);

      expect(checkServerRunning).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledTimes(1);

      liveRcon.stopAutoReconnect();
      vi.useRealTimers();
    });
  });

  describe('serverMessage text safety', () => {
    it('strips emoji and other non-ASCII chars before sending to PZ', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await liveRcon.serverMessage('🔧 Mod updates detected: CleanUI. Server will restart in 5 minute(s).');

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const sent = executeSpy.mock.calls[0][0];
      expect(sent).not.toMatch(/[^\x20-\x7E"]/);
      expect(sent).toContain('Mod updates detected');
      expect(sent).toContain('5 minute(s)');
      expect(sent).not.toContain('🔧');
    });

    it('replaces curly quotes/dashes with ASCII equivalents', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await liveRcon.serverMessage('It\u2019s \u2014 \u201Ctest\u201D');

      const sent = executeSpy.mock.calls[0][0];
      expect(sent).toContain("It's");
      expect(sent).toContain('-');
      expect(sent).toContain('test');
      expect(sent).not.toMatch(/[\u2018\u2019\u201C\u201D\u2013\u2014]/);
    });

    it('returns rejected:true when PZ replies with the help text', async () => {
      const liveRcon = new RconService();
      vi.spyOn(liveRcon, 'execute').mockResolvedValue({
        success: true,
        response: 'Broadcast a message to all connected players. Use: /servermsg "My Message"',
      });

      const result = await liveRcon.serverMessage('Hello');
      expect(result.rejected).toBe(true);
      expect(result.success).toBe(false);
    });

    it('returns success when PZ broadcasts normally', async () => {
      const liveRcon = new RconService();
      vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'Command executed successfully' });

      const result = await liveRcon.serverMessage('Hello players');
      expect(result.success).toBe(true);
      expect(result.rejected).toBeUndefined();
    });

    it('skips sending when message reduces to empty after sanitization', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true });

      const result = await liveRcon.serverMessage('🔧🎯💀');
      expect(executeSpy).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });

    it('preserves accented Latin letters in broadcasts', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await liveRcon.serverMessage('Redemarrage du serveur \u00e0 20h, merci de vous d\u00e9connecter');

      const sent = executeSpy.mock.calls[0][0];
      expect(sent).toContain('Redemarrage du serveur \u00e0 20h');
      expect(sent).toContain('d\u00e9connecter');
    });

    it('preserves Chinese scheduled-message text while keeping command delimiters out', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });
      const message = "\u670d\u52a1\u5668\u5c06\u5728\u4e94\u5206\u949f\u540e\u91cd\u542f\"\\quit\n";

      await liveRcon.serverMessage(message, { skipLog: true });

      expect(executeSpy).toHaveBeenCalledWith(
        'servermsg "\u670d\u52a1\u5668\u5c06\u5728\u4e94\u5206\u949f\u540e\u91cd\u542fquit"',
        { skipLog: true },
      );
    });
  });

  describe('sanitizeForBanReason / banPlayer (shared ASCII folding)', () => {
    it('transliterates accents and normalizes curly quotes the same way serverMessage() does', () => {
      const liveRcon = new RconService();
      const sanitized = liveRcon.sanitizeForBanReason(
        'Comportement toxique r\u00e9p\u00e9t\u00e9, insultes \u00e0 d\u2019autres joueurs',
      );
      expect(sanitized).toBe("Comportement toxique repete, insultes a d'autres joueurs");
    });

    it('still strips characters outside the ban-reason whitelist after folding (quotes, backslash, symbols)', () => {
      const liveRcon = new RconService();
      const sanitized = liveRcon.sanitizeForBanReason('griefing "the base" \\ 100% <script>');
      expect(sanitized).not.toMatch(/["\\<>]/);
    });

    it('banPlayer() returns sentReason -- the ACTUAL text sent to RCON, which callers should log instead of the raw input', async () => {
      const liveRcon = new RconService();
      vi.spyOn(liveRcon, 'sanitizeQuotedArg').mockReturnValue('Bob');
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      const result = await liveRcon.banPlayer(
        'Bob',
        false,
        'Comportement toxique r\u00e9p\u00e9t\u00e9',
      );

      expect(result.sentReason).toBe('Comportement toxique repete');
      const cmd = executeSpy.mock.calls[0][0];
      expect(cmd).toContain('Comportement toxique repete');
      expect(cmd).not.toContain('r\u00e9p\u00e9t\u00e9');
    });
  });

  describe('classifyRconResponse (rejection shapes execute() recognizes as failure)', () => {
    it('still classifies "Unknown command" as a failure', () => {
      const liveRcon = new RconService();
      const result = liveRcon.classifyRconResponse('Unknown command "foo"');
      expect(result).not.toBeNull();
      expect(result.error).toContain('not available on this server build');
    });

    it('classifies "Wrong arguments!" as a failure -- seen verbatim in GodModePlayerCommand.class/InvisiblePlayerCommand.class', () => {
      const liveRcon = new RconService();
      const result = liveRcon.classifyRconResponse('Wrong arguments!');
      expect(result).not.toBeNull();
      expect(result.error).toMatch(/syntax may have changed/i);
    });

    it('classifies "Not enough rights" as a failure -- seen verbatim in NoClipCommand.class', () => {
      const liveRcon = new RconService();
      const result = liveRcon.classifyRconResponse('Not enough rights');
      expect(result).not.toBeNull();
      expect(result.error).toMatch(/does not have permission/i);
    });

    it('classifies "<command> can be executed only from the game" as a failure -- seen verbatim in ReleaseSafehouseCommand.class', () => {
      const liveRcon = new RconService();
      const result = liveRcon.classifyRconResponse('releasesafehouse can be executed only from the game');
      expect(result).not.toBeNull();
      expect(result.error).toMatch(/only be run from in-game/i);
    });

    it('does not classify an ordinary informative response as a failure', () => {
      const liveRcon = new RconService();
      expect(liveRcon.classifyRconResponse('Players connected (2):\n-Alice\n-Bob')).toBeNull();
      expect(liveRcon.classifyRconResponse('')).toBeNull();
      expect(liveRcon.classifyRconResponse(undefined)).toBeNull();
    });
  });

  describe('setGodMode / setInvisible player targeting', () => {
    it('setGodMode sends godmodplayer (not the self-only godmod) when a username is given', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await liveRcon.setGodMode('Bob', true);

      expect(executeSpy).toHaveBeenCalledWith('godmodplayer "Bob" -true');
    });

    it('setGodMode still sends the self-only godmod when no username is given', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await liveRcon.setGodMode(null, false);

      expect(executeSpy).toHaveBeenCalledWith('godmod -false');
    });

    it('setInvisible sends invisibleplayer (not the self-only invisible) when a username is given', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await liveRcon.setInvisible('Bob', true);

      expect(executeSpy).toHaveBeenCalledWith('invisibleplayer "Bob" -true');
    });

    it('setInvisible still sends the self-only invisible when no username is given', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await liveRcon.setInvisible(null, false);

      expect(executeSpy).toHaveBeenCalledWith('invisible -false');
    });
  });

  describe('releaseSafehouse', () => {
    it('refuses honestly instead of sending a command the real server always rejects over RCON', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute');

      await expect(liveRcon.releaseSafehouse()).rejects.toThrow(/only be done from in-game/i);
      expect(executeSpy).not.toHaveBeenCalled();
    });
  });

  describe('kickPlayer reason', () => {
    it('sends -r "<reason>" -- KickUserCommand.class carries the same -r AltCommandArgs flag as BanUserCommand in the real B42 jar', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await liveRcon.kickPlayer('Bob', 'Comportement toxique répété');

      expect(executeSpy).toHaveBeenCalledWith('kickuser "Bob" -r "Comportement toxique repete"');
    });

    it('omits -r entirely when no reason is given', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await liveRcon.kickPlayer('Bob');

      expect(executeSpy).toHaveBeenCalledWith('kickuser "Bob"');
    });
  });

  describe('quoted argument safety', () => {
    it('rejects player names that could break out of quoted RCON args', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await expect(liveRcon.kickPlayer('Player" servermsg "owned')).rejects.toThrow('Username contains unsupported characters');
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('rejects control characters in quoted RCON args', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await expect(liveRcon.addToWhitelist('Admin\nquit')).rejects.toThrow('Username contains unsupported characters');
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('preserves safe quoted arguments instead of rewriting them', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await liveRcon.setAccessLevel('Safe Player', 'admin');

      expect(executeSpy).toHaveBeenCalledWith('setaccesslevel "Safe Player" "admin"');
    });

    it('matches Build 42 whitelist commands for optional passwords and allowed Steam IDs', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await liveRcon.addToWhitelist('NoPassword');
      await liveRcon.addAllowedSteamId('76561198000000000');
      await liveRcon.removeAllowedSteamId('76561198000000000');

      expect(executeSpy.mock.calls).toEqual([
        ['adduser "NoPassword"'],
        ['addSteamID 76561198000000000'],
        ['removeSteamID 76561198000000000'],
      ]);
    });
  });
});
