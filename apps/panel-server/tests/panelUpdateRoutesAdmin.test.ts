import { describe, expect, it, vi } from "vite-plus/test";

const { default: router } = await import("../routes/core.ts");

const guardedRoutes = [
  ["get", "/panel/update-check"],
  ["get", "/panel/update-status"],
  ["get", "/panel/update-preflight"],
  ["get", "/panel/update-apply-log"],
  ["post", "/panel/update-download"],
  ["post", "/panel/restart"],
];

function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("panel update and restart authorization", () => {
  it.each(guardedRoutes)("rejects non-admin requests to %s %s before dispatch", async (method, routePath) => {
    const layer = router.stack.find(
      (entry) => entry.route?.path === routePath && entry.route.methods[method],
    );
    const next = vi.fn();
    const res = response();
    await layer.route.stack[0].handle({ user: { role: "technician" } }, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it.each([{ role: "admin" }, { authDisabled: true }])("allows the configured administrator access to update status", async (user) => {
    const res = response();
    await router(
      {
        method: "GET",
        path: "/panel/update-status",
        user,
        app: { get: () => ({ getStatus: () => ({ version: "test" }) }) },
      },
      res,
      vi.fn(),
    );

    expect(res.json).toHaveBeenCalledWith({ version: "test" });
    expect(res.status).not.toHaveBeenCalledWith(403);
  });
});
