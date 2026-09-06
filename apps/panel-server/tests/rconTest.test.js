import { describe, expect, it, vi } from 'vitest';
import net from 'net';
import { testRconConnection, RCON_UNREACHABLE_DETAIL } from '../services/rcon.js';
import router from '../routes/rcon.js';
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
  // LAST entry, not the first: requireRole('admin', 'technician') is now
  // ahead of the real handler in this route's stack (role sweep), so index
  // 0 would grab the role-gate middleware instead of the route logic this
  // test actually exercises.
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
    // Nothing listens on this loopback port in the test environment, so the
    // connection is refused (or times out) rather than authenticating.
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
    // A bare TCP server that accepts the connection but never speaks the
    // RCON protocol -- authenticate() times out and rejects, exercising the
    // auth_failed branch without needing a real RCON server.
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
          // Mirrors the real RconService (services/rcon.js) enough to
          // survive the unreachable-vs-auth-failed classification a failed
          // connect() falls through to: getConfig() for the reachability
          // re-probe, getUserFriendlyError() for the outer catch's
          // fallback. A mock missing either one crashes here instead of in
          // production -- exactly what happened when this test's mock went
          // stale against a real /connect change; see
          // routeRoleSweep.test.js:298 for the same lesson learned earlier.
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

    // The behaviour this test is named for: an explicitly empty password is
    // passed through, not dropped for being falsy.
    expect(updateConfig).toHaveBeenCalledWith(undefined, undefined, '');
    // 39822: nothing listens there in the test environment (same convention
    // as this file's other tests above), so the failed connect() above is
    // deliberately classified as unreachable -- not just "didn't crash".
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

// 2026-08-27 bug hunt: POST /execute broadcasts its command AND response to
// a socket room via rcon:response, and separately logs the command via
// log.info -- both were the raw, unredacted string. logCommand()
// (database/init.js) already redacts an adduser password before persisting
// to command_history for exactly this reason (see rconCommandRedaction.js);
// these two sites were never brought in line, so `adduser "Bob" "hunter2"`
// still reached every subscribed socket, and every log line, in cleartext.
// Wire-level coverage: calls the real handler and asserts on what actually
// got emitted/logged, not on source text.
//
// 2026-08-31 bug hunt: the broadcast target moved from "logs" (gated
// diagnostics.manage in index.js) to "rcon-live" (gated rcon.execute) --
// the same content class GET /api/rcon/history has always gated rcon.execute
// alone, per this file's own header comment above. diagnostics.manage is a
// different, broader capability a custom "diagnostics-only observer" role
// could plausibly hold without rcon.execute, per that capability's own
// catalogue description (never mentions RCON). Tests below assert the room
// name explicitly, and one proves "logs" no longer receives it at all --
// a retarget bug is invisible to a test that only checks the event fired
// somewhere.
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

    expect(res.statusCode).toBe(undefined); // res.json(), no explicit status -- 200 default
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
    // The control that makes the above meaningful: a fix that broadcast to
    // BOTH rooms would still pass a test that only checks "rcon-live" was
    // used somewhere -- confirm "logs" gets nothing at all from this route.
    expect(io.emitted.some((e) => e.room === 'logs')).toBe(false);
  });
});
