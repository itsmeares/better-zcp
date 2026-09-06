import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePanelUpdateDownload } from "../index.js";
import { ServerManager } from "../services/serverManager.js";

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

describe("Docker panel update process-state guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses to start a Docker update when process detection fails", async () => {
    vi.spyOn(ServerManager.prototype, "getServerProcessDetails").mockResolvedValue({
      running: false,
      scanFailed: true,
    });
    const downloadUpdate = vi.fn();
    const response = createResponse();

    await handlePanelUpdateDownload(
      {
        body: { confirm: true },
        app: {
          get: (key) =>
            key === "panelUpdateChecker"
              ? { dockerUpdateProxy: { enabled: true }, downloadUpdate }
              : undefined,
        },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "SERVER_STATE_UNKNOWN",
      }),
    );
    expect(downloadUpdate).not.toHaveBeenCalled();
  });

  it("continues when process detection confirms the server is stopped", async () => {
    vi.spyOn(ServerManager.prototype, "getServerProcessDetails").mockResolvedValue({
      running: false,
      scanFailed: false,
    });
    const downloadUpdate = vi.fn(async () => ({
      success: false,
      code: "no_update",
      error: "No update available",
    }));
    const response = createResponse();

    await handlePanelUpdateDownload(
      {
        body: { confirm: true },
        app: {
          get: (key) =>
            key === "panelUpdateChecker"
              ? { dockerUpdateProxy: { enabled: true }, downloadUpdate }
              : undefined,
        },
      },
      response,
    );

    expect(downloadUpdate).toHaveBeenCalledOnce();
    expect(response.status).toHaveBeenCalledWith(400);
  });
});