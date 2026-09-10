import { describe, expect, it, vi } from 'vitest';

const ROLES = {
  rcon_only: { name: 'rcon_only', capabilities: ['rcon.execute'] },
  rcon_and_servers: {
    name: 'rcon_and_servers',
    capabilities: ['rcon.execute', 'servers.manage'],
  },
};

vi.mock('../database/init.ts', () => ({
  getRoleByName: vi.fn((name) => Promise.resolve(ROLES[name] || null)),
}));

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

async function runPostRoute(routePath, req) {
  const { default: router } = await import('../routes/rcon.ts');
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods.post,
  );
  const handlers = layer.route.stack.map((s) => s.handle);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

const runTestRoute = (req) => runPostRoute('/test', req);
const runConnectRoute = (req) => runPostRoute('/connect', req);

describe('POST /api/rcon/test requires servers.manage in addition to rcon.execute', () => {
  it('refuses a role holding rcon.execute alone, before ever probing the host', async () => {
    const res = await runTestRoute({
      user: { role: 'rcon_only' },
      body: { host: '10.0.0.1', port: 27015, password: 'x' },
      app: { get: () => undefined },
    });
    expect(res.statusCode).toBe(403);
  });

  it('does not refuse a role holding both rcon.execute and servers.manage at the gate', async () => {
    const res = await runTestRoute({
      user: { role: 'rcon_and_servers' },
      body: { host: '127.0.0.1', port: 39822, password: 'x' },
      app: { get: () => undefined },
    });
    expect(res.statusCode).not.toBe(403);
  });
});

describe('POST /api/rcon/connect only permits explicit host/port overrides for server managers', () => {
  it('refuses a custom target from a role that can execute RCON but cannot manage servers', async () => {
    const connect = vi.fn();
    const res = await runConnectRoute({
      user: { role: 'rcon_only' },
      body: { host: '10.0.0.1', port: 27015 },
      app: { get: () => ({ connect }) },
    });

    expect(res.statusCode).toBe(403);
    expect(connect).not.toHaveBeenCalled();
  });

  it('also refuses a password-only override, which could redirect the shared credential', async () => {
    const updateConfig = vi.fn();
    const connect = vi.fn();
    const res = await runConnectRoute({
      user: { role: 'rcon_only' },
      body: { password: 'attacker-chosen-password' },
      app: { get: () => ({ updateConfig, connect }) },
    });

    expect(res.statusCode).toBe(403);
    expect(updateConfig).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});
