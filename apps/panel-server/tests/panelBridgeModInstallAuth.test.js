import { describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getServer: vi.fn(),
  getAllSettings: vi.fn(),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand: vi.fn(),
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/panelBridge.js");
const { getServer } = await import("../database/init.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getLayer(routePath, method) {
  return router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runRoute(routePath, method, req, res) {
  const layer = getLayer(routePath, method);
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
}

// Finding 9: PanelBridge installation routes were missing the
// requireRole("admin") guard every other privileged PanelBridge route has
// (see /sftp/*, /command).
describe("PanelBridge mod-install routes require admin", () => {
  it("rejects POST /install-local for a non-admin authenticated user", async () => {
    const response = createResponse();
    await runRoute(
      "/install-local",
      "post",
      { body: {}, user: { role: "viewer" } },
      response,
    );
    expect(response.status).toHaveBeenCalledWith(403);
  });

  it("rejects POST /install-mod-auto for a non-admin authenticated user", async () => {
    const response = createResponse();
    await runRoute(
      "/install-mod-auto",
      "post",
      { body: {}, user: { role: "viewer" } },
      response,
    );
    expect(response.status).toHaveBeenCalledWith(403);
  });

  it("explains that remote servers require manual or SFTP installation", async () => {
    getServer.mockResolvedValue({
      id: "remote-1",
      isRemote: true,
      name: "Remote PZ",
      serverName: "servertest",
    });
    const response = createResponse();

    await runRoute(
      "/install-mod-auto",
      "post",
      { body: { serverId: "remote-1" }, user: { role: "admin" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: expect.stringMatching(/remote servers.*SFTP/i),
      code: "PANELBRIDGE_INSTALL_REMOTE_NOT_AVAILABLE",
    });
  });

  it("rejects POST /install-mod for a non-admin authenticated user", async () => {
    const response = createResponse();
    await runRoute(
      "/install-mod",
      "post",
      { body: {}, user: { role: "viewer" } },
      response,
    );
    expect(response.status).toHaveBeenCalledWith(403);
  });
});
