import { describe, expect, it } from 'vitest';
import net from 'net';
import router from '../routes/rcon.js';
import { RCON_UNREACHABLE_DETAIL, RCON_AUTH_FAILED_DETAIL } from '../services/rcon.js';

// POST /api/rcon/connect used to collapse "host never reachable" and
// "reachable, but the password is wrong" into one generic message
// (RCON_CONNECT_FAILED), while POST /api/rcon/test already told the two
// apart -- see conv install-idiot-proofing-2026-08. This locks in the fix:
// /connect must now report the SAME two canonical detail strings /test uses,
// so a silent regression back to the old generic string fails a test rather
// than only showing up as a worse dashboard message.

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

function getConnectHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === '/connect' && entry.route.methods.post,
  );
  // LAST entry, not the first: requirePermission('rcon.execute') sits ahead
  // of the real handler in this route's stack, same as /test (see
  // rconTest.test.js's identical comment).
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeReq(rconService, body = {}) {
  return {
    body,
    app: { get: (key) => (key === 'rconService' ? rconService : undefined) },
  };
}

describe('POST /api/rcon/connect granularity', () => {
  it('reports "unreachable" when the configured host:port cannot be reached', async () => {
    // Nothing listens on this loopback port in the test environment.
    const fakeRconService = {
      connect: async () => false,
      getConfig: () => ({ host: '127.0.0.1', port: 39822 }),
    };

    const res = createResponse();
    await getConnectHandler()(makeReq(fakeRconService), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: RCON_UNREACHABLE_DETAIL,
      code: 'RCON_CONNECT_UNREACHABLE',
    });
  });

  it('reports "auth failed" when the host:port IS reachable but connect() still fails', async () => {
    // A bare TCP server that accepts the connection but never speaks RCON --
    // reachable by the follow-up probe, exactly the case that used to come
    // back as the same generic "Could not connect to RCON" string as the
    // unreachable case above.
    const server = net.createServer((socket) => socket.on('data', () => {}));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const fakeRconService = {
        connect: async () => {
          throw new Error('RCON authentication failed (wrong password)');
        },
        getConfig: () => ({ host: '127.0.0.1', port }),
      };

      const res = createResponse();
      await getConnectHandler()(makeReq(fakeRconService), res);

      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({
        success: false,
        error: RCON_AUTH_FAILED_DETAIL,
        code: 'RCON_CONNECT_AUTH_FAILED',
      });
    } finally {
      server.close();
    }
  });

  it('also classifies as "auth failed" when connect() resolves false instead of throwing, as long as the host:port is reachable', async () => {
    // rconService.connect() resolves false for some failures and throws for
    // others -- the route must not depend on which; both mean "did not
    // connect" and get reclassified by the reachability probe.
    const server = net.createServer((socket) => socket.on('data', () => {}));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const fakeRconService = {
        connect: async () => false,
        getConfig: () => ({ host: '127.0.0.1', port }),
      };

      const res = createResponse();
      await getConnectHandler()(makeReq(fakeRconService), res);

      expect(res.body).toEqual({
        success: false,
        error: RCON_AUTH_FAILED_DETAIL,
        code: 'RCON_CONNECT_AUTH_FAILED',
      });
    } finally {
      server.close();
    }
  });

  it('still reports success on a real connect()', async () => {
    const fakeRconService = {
      connect: async () => true,
      getConfig: () => ({ host: '127.0.0.1', port: 27015 }),
    };

    const res = createResponse();
    await getConnectHandler()(makeReq(fakeRconService), res);

    expect(res.body).toEqual({ success: true, message: 'Connected to RCON' });
  });
});
