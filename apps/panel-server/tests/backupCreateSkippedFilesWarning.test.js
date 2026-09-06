import { describe, expect, it, vi } from "vitest";


vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => ({ isRemote: false })),
}));

const { default: router } = await import("../routes/backup.ts");

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

describe("POST /backup/create -- routine backup tolerates a skip and surfaces it", () => {
  it("returns success:true with a warnings array when the backup completed but skipped a file", async () => {
    const backupService = {
      createBackup: vi.fn(async () => ({
        success: true,
        backup: { name: "servertest_2026.zip" },
        skippedFiles: ["servertest/some.tmp"],
      })),
    };
    const response = createResponse();

    await getHandler("/create", "post")(
      { body: {}, app: { get: (key) => (key === "backupService" ? backupService : undefined) } },
      response,
    );

    expect(response.status).not.toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        warnings: [expect.stringContaining("some.tmp")],
      }),
    );
  });

  it("returns the plain result with no warnings field when nothing was skipped", async () => {
    const backupService = {
      createBackup: vi.fn(async () => ({
        success: true,
        backup: { name: "servertest_2026.zip" },
        skippedFiles: [],
      })),
    };
    const response = createResponse();

    await getHandler("/create", "post")(
      { body: {}, app: { get: (key) => (key === "backupService" ? backupService : undefined) } },
      response,
    );

    const [payload] = response.json.mock.calls[0];
    expect(payload.success).toBe(true);
    expect(payload.warnings).toBeUndefined();
  });
});
