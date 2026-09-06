import { describe, expect, it, vi } from "vitest";

const listBackupRecords = vi.fn();

vi.mock("../database/init.js", () => ({ getActiveServer: vi.fn() }));
vi.mock("../services/auth.js", () => ({ requireRole: () => (_req, _res, next) => next() }));
vi.mock("../services/backupRecords.js", () => ({ listBackupRecords }));

const { default: router } = await import("../routes/backup.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

it("filters backup history by server and bounds the requested limit", async () => {
  listBackupRecords.mockResolvedValue([{ fileName: "DoomerZ.zip" }]);
  const response = createResponse();
  const layer = router.stack.find((entry) => entry.route?.path === "/history");
  const handler = layer.route.stack.at(-1).handle;

  await handler({ query: { serverId: "server-1", limit: "9999" } }, response);

  expect(listBackupRecords).toHaveBeenCalledWith({ serverId: "server-1", limit: 500 });
  expect(response.json).toHaveBeenCalledWith({ records: [{ fileName: "DoomerZ.zip" }] });
});

it("returns 400 for a missing backup settings body", async () => {
  const response = createResponse();
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/settings" && entry.route.methods.post,
  );
  const handler = layer.route.stack.at(-1).handle;

  await handler(
    {
      body: null,
      app: { get: () => ({}) },
    },
    response,
  );

  expect(response.status).toHaveBeenCalledWith(400);
  expect(response.json).toHaveBeenCalledWith({
    success: false,
    error: "Request body must be an object",
  });
});