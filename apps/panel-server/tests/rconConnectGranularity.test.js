import { describe, expect, it } from 'vitest';
import net from 'net';
import router from '../routes/rcon.ts';
import { RCON_UNREACHABLE_DETAIL, RCON_AUTH_FAILED_DETAIL } from '../services/rcon.ts';


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
