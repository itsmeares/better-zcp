import { describe, expect, it, vi } from "vitest";

// 2026-08-26 bug hunt: createBackup surfaces skipped files (ones that
// vanished mid-archive -- a real race on a live PZ directory) rather than
// deciding policy itself, since the same skip means different things
// depending on why the backup exists. This is the routine/manual path
// (POST /backup/create): a skip here is tolerated, not fatal -- almost
// always a temp/log/lock file the running server rewrote mid-backup -- but
// it must be visible rather than silently dropped, so it's surfaced as a
// warnings array, the same reloadWarnings/scriptWarnings convention used
// elsewhere tonight. Contrast with restoreBackup's pre-restore backup and
// /wipe's pre-wipe backup, which treat any skip as an outright failure
// (covered in backupRestoreSafety.test.js and wipeBackup.test.js) because
// THOSE backups are about to become the world's only copy.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => ({ isRemote: false })),
}));

const { default: router } = await import("../routes/backup.js");

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
