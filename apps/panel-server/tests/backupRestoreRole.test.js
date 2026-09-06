import { describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.js", () => ({
  getRoleByName: mockGetRoleByName,
}));

// Restore is deliberately narrower than the rest of backup.js: deleting a
// backup destroys the operator's own safety net (housekeeping), but
// restoring one rolls the live world back over every player currently
// standing in it. This checks BOTH directions per god's standard -- a test
// that only proves restore is locked would pass just as well if the whole
// file had been locked to admin, which is exactly the mistake this file
// exists to rule out.

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.getStatusCode = () => statusCode;
  return response;
}

function getGate(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  // requirePermission is always the first handler in backup.js's per-route stacks.
  return layer.route.stack[0].handle;
}

async function runGate(router, routePath, method, role) {
  const res = createResponse();
  let calledNext = false;
  await getGate(router, routePath, method)(
    { user: { role } },
    res,
    () => {
      calledNext = true;
    },
  );
  return { res, calledNext };
}

describe("backup.js: POST /restore/:name is admin-only", () => {
  it("refuses a technician", async () => {
    const { default: router } = await import("../routes/backup.js");
    const { res, calledNext } = await runGate(router, "/restore/:name", "post", "technician");
    expect(res.getStatusCode()).toBe(403);
    expect(calledNext).toBe(false);
  });

  it("refuses a moderator", async () => {
    const { default: router } = await import("../routes/backup.js");
    const { res } = await runGate(router, "/restore/:name", "post", "moderator");
    expect(res.getStatusCode()).toBe(403);
  });

  it("does not refuse an admin", async () => {
    const { default: router } = await import("../routes/backup.js");
    const { calledNext } = await runGate(router, "/restore/:name", "post", "admin");
    expect(calledNext).toBe(true);
  });
});

describe("backup.js: everything else stays admin+technician (restore is the only route narrowed)", () => {
  const STILL_TECHNICIAN = [
    ["/settings", "post"],
    ["/create", "post"],
    ["/:name", "delete"],
    ["/delete-older-than", "post"],
    ["/upload", "post"],
    ["/:name/snapshot", "get"],
    ["/download/:name", "get"],
  ];

  it.each(STILL_TECHNICIAN)("does not refuse a technician on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/backup.js");
    const { calledNext } = await runGate(router, routePath, method, "technician");
    expect(calledNext).toBe(true);
  });

  it.each(STILL_TECHNICIAN)("still refuses a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/backup.js");
    const { res } = await runGate(router, routePath, method, "moderator");
    expect(res.getStatusCode()).toBe(403);
  });
});
