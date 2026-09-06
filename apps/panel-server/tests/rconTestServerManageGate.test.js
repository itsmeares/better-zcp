import { describe, expect, it, vi } from 'vitest';

// CodeQL js/request-forgery #26/#333 (2026-08-27 triage, operator-ruled
// fix): POST /rcon/test made the panel open a raw TCP connection (and
// attempt an RCON auth handshake) against ANY host/port the caller named,
// gated by rcon.execute alone. rcon.execute's own description ("execute
// arbitrary console commands" against the configured server) never
// promised "connect to arbitrary hosts" -- a role built with ONLY
// rcon.execute (a real, supported thing to do via Roles & Permissions,
// same shape as every other capability-granularity gap found tonight)
// could use this route as a blind internal-network TCP prober. Fixed by
// requiring servers.manage in addition: you need the power to add a
// server to be allowed to test one.
//
// A custom role, not one of the three stock fixtures, is the point of this
// test: TECHNICIAN and ADMIN both already hold servers.manage alongside
// rcon.execute, so neither stock role's fixture can distinguish "the gate
// checks both capabilities" from "the gate checks nothing new at all" --
// only a role holding rcon.execute WITHOUT servers.manage can prove that.
const ROLES = {
  rcon_only: { name: 'rcon_only', capabilities: ['rcon.execute'] },
  rcon_and_servers: {
    name: 'rcon_and_servers',
    capabilities: ['rcon.execute', 'servers.manage'],
  },
};

vi.mock('../database/init.js', () => ({
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

async function runTestRoute(req) {
  const { default: router } = await import('../routes/rcon.js');
  const layer = router.stack.find(
    (entry) => entry.route?.path === '/test' && entry.route.methods.post,
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
      // Nothing listens on this loopback port -- the point here is only
      // that the gate let the request past to the real handler, not what
      // the (unreachable) test connection itself reports.
      body: { host: '127.0.0.1', port: 39822, password: 'x' },
      app: { get: () => undefined },
    });
    expect(res.statusCode).not.toBe(403);
  });
});
