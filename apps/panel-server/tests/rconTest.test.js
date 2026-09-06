import { describe, expect, it, vi } from 'vitest';
import net from 'net';
import { testRconConnection, RCON_UNREACHABLE_DETAIL } from '../services/rcon.js';
import router from '../routes/rcon.ts';
import { ErrorCode } from '../utils/errorCodes.js';

function createResponse() {
  const response = {};
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
}

function getTestHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === '/test' && entry.route.methods.post,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getConnectHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === '/connect' && entry.route.methods.post,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getHandler(path) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods.post,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe('testRconConnection', () => {
  it('returns unreachable when the TCP connection cannot be established', async () => {
    const result = await testRconConnection({
      host: '127.0.0.1',
      port: 39822,
      password: 'whatever',
      timeoutMs: 1000,
    });
    expect(result).toEqual({
      success: false,
      error: 'unreachable',
      detail: 'Unreachable: check host and port',
    });
  });

  it('returns auth_failed when TCP connects but RCON auth never completes', async () => {
    const server = net.createServer((socket) => socket.on('data', () => {}));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const result = await testRconConnection({
        host: '127.0.0.1',
        port,
        password: 'wrong-password',
        timeoutMs: 300,
      });
      expect(result).toEqual({
        success: false,
        error: 'auth_failed',
        detail: 'Authentication failed: check RCON password',
      });
    } finally {
      server.close();
    }
  });
});

describe('POST /api/rcon/test route validation', () => {
  it('rejects an invalid host format with 400', async () => {
    const res = createResponse();
    await getTestHandler()(
      { body: { host: 'not a host!', port: 27015, password: 'x' } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'invalid_input',
      detail: 'Invalid host format',
    });
  });

  it('rejects an out-of-range port with 400', async () => {
    const res = createResponse();
    await getTestHandler()(
      { body: { host: '127.0.0.1', port: 99999, password: 'x' } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.detail).toBe('Invalid port (1-65535)');
  });

  it('rejects a port with trailing junk instead of accepting its numeric prefix', async () => {
    const res = createResponse();
    await getTestHandler()(
      { body: { host: '127.0.0.1', port: '27015junk', password: 'x' } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.detail).toBe('Invalid port (1-65535)');
  });

  it('reports unreachable for a closed local port via the real handler', async () => {
    const res = createResponse();
    await getTestHandler()(
      { body: { host: '127.0.0.1', port: 39822, password: 'x' } },
      res,
    );
    expect(res.body).toEqual({
      success: false,
      error: 'unreachable',
      detail: 'Unreachable: check host and port',
    });
  });
});

describe('POST /api/rcon/connect route updates', () => {
  it('applies an explicitly empty password instead of retaining the old one', async () => {
    const updateConfig = vi.fn();
    const connect = vi.fn(async () => false);
    const res = createResponse();

    await getConnectHandler()(
      {
        body: { password: '' },
        app: {
          get: () => ({
            updateConfig,
            connect,
            getConfig: () => ({ host: '127.0.0.1', port: 39822 }),
            getUserFriendlyError: () => 'stub error',
          }),
        },
      },
      res,
    );

    expect(updateConfig).toHaveBeenCalledWith(undefined, undefined, '');
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: RCON_UNREACHABLE_DETAIL,
      code: ErrorCode.RCON_CONNECT_UNREACHABLE,
    });
  });

  it('returns a client error for a missing body', async () => {
    const updateConfig = vi.fn();
    const res = createResponse();

    await getConnectHandler()(
      {
        body: null,
        app: { get: () => ({ updateConfig, connect: vi.fn() }) },
      },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(updateConfig).not.toHaveBeenCalled();
  });
});

describe('RCON route malformed request handling', () => {
  it('returns 400 for a missing test body', async () => {
    const res = createResponse();

    await getTestHandler()({ body: null }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.detail).toBe('Invalid host format');
  });

  it('returns 400 for a non-string execute command without throwing', async () => {
    const res = createResponse();

    await getHandler('/execute')(
      { body: { command: 123 }, app: { get: vi.fn() } },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('RCON_COMMAND_INVALID');
  });
});

describe('RCON /execute -- redacts secrets before they leave the route', () => {
  function createIoMock() {
    const emitted = [];
    return {
      emitted,
      to: (room) => ({
        emit: (event, payload) => emitted.push({ room, event, payload }),
      }),
    };
  }

  it('redacts the adduser password in the rcon:response broadcast, both command and response fields', async () => {
    const res = createResponse();
    const io = createIoMock();
    const rconService = {
      execute: vi.fn(async () => ({
        success: true,
        response: 'Command received: adduser "Bob" "hunter2" -> User added',
      })),
    };

    await getHandler('/execute')(
      {
        body: { command: 'adduser "Bob" "hunter2"' },
        app: { get: (key) => (key === 'rconService' ? rconService : io) },
      },
      res,
    );

    expect(res.statusCode).toBe(undefined);
    const broadcast = io.emitted.find((e) => e.event === 'rcon:response');
    expect(broadcast.payload.command).toBe('adduser "Bob" "[REDACTED]"');
    expect(broadcast.payload.response).toBe(
      'Command received: adduser "Bob" "[REDACTED]" -> User added',
    );
  });

  it('does not alter a command with no password to redact', async () => {
    const res = createResponse();
    const io = createIoMock();
    const rconService = {
      execute: vi.fn(async () => ({ success: true, response: 'players: Bob' })),
    };

    await getHandler('/execute')(
      {
        body: { command: 'players' },
        app: { get: (key) => (key === 'rconService' ? rconService : io) },
      },
      res,
    );

    const broadcast = io.emitted.find((e) => e.event === 'rcon:response');
    expect(broadcast.payload.command).toBe('players');
    expect(broadcast.payload.response).toBe('players: Bob');
  });

  it('broadcasts rcon:response into the "rcon-live" room, not "logs" -- rcon.execute is the gate, not the broader diagnostics.manage', async () => {
    const res = createResponse();
    const io = createIoMock();
    const rconService = {
      execute: vi.fn(async () => ({ success: true, response: 'players: Bob' })),
    };

    await getHandler('/execute')(
      {
        body: { command: 'players' },
        app: { get: (key) => (key === 'rconService' ? rconService : io) },
      },
      res,
    );

    const broadcast = io.emitted.find((e) => e.event === 'rcon:response');
    expect(broadcast.room).toBe('rcon-live');
    expect(io.emitted.some((e) => e.room === 'logs')).toBe(false);
  });
});
