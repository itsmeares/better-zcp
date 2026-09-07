import { describe, expect, it, vi } from "vitest";

const db = { data: { roles: [] } };

vi.mock("../database/init.ts", () => ({
  getRoleByName: async (name) =>
    db.data.roles.find((r) => r.name === name) || null,
}));

const { default: backupRouter } = await import("../routes/backup.ts");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getGate(routePath, method) {
  const layer = backupRouter.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[0].handle;
}

async function runGate(routePath, method, req) {
  const res = createResponse();
  let calledNext = false;
  await getGate(routePath, method)(req, res, () => {
    calledNext = true;
  });
  return { res, calledNext };
}

describe("GET /api/backup/download/:name — backups.download specifically, not backups.manage", () => {
  it("refuses a role holding backups.manage but NOT backups.download", async () => {
    db.data.roles = [
      { name: "housekeeper", capabilities: ["backups.manage"], isSeeded: false },
    ];
    const { res, calledNext } = await runGate("/download/:name", "get", {
      user: { role: "housekeeper" },
    });
    expect(calledNext).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("admits a role holding backups.download but NOT backups.manage", async () => {
    db.data.roles = [
      { name: "offsite-courier", capabilities: ["backups.download"], isSeeded: false },
    ];
    const { calledNext } = await runGate("/download/:name", "get", {
      user: { role: "offsite-courier" },
    });
    expect(calledNext).toBe(true);
  });

  it("refuses with no req.user at all (401), not treated as a permission decision", async () => {
    db.data.roles = [];
    const { res, calledNext } = await runGate("/download/:name", "get", {});
    expect(calledNext).toBe(false);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
