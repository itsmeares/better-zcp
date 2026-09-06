import { describe, expect, it, vi } from "vitest";
import { apiErrorHandler, handlePanelUpdateDownload } from "../index.js";
import { ErrorCode } from "../utils/errorCodes.ts";


function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

describe("apiErrorHandler: registry is an allowlist, not a passthrough", () => {
  it("forwards err.code when it is a registered ErrorCode value (uses APPLY_IN_PROGRESS_LEGACY -- the one code whose only other protection was a hand-written per-catch-site check)", () => {
    const res = createResponse();
    const err = new Error("An update apply is already in progress.");
    err.code = ErrorCode.APPLY_IN_PROGRESS_LEGACY;
    err.status = 409;

    apiErrorHandler(err, { method: "POST", path: "/api/panel/update-apply" }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "apply_in_progress" }),
    );
  });

  it("does NOT forward an unregistered code (e.g. ENOENT, a raw Node internal) -- the load-bearing direction", () => {
    const res = createResponse();
    const err = new Error("ENOENT: no such file or directory, open '/some/path'");
    err.code = "ENOENT";

    apiErrorHandler(err, { method: "GET", path: "/api/some-route" }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body).not.toHaveProperty("code");
    expect(body.error).toBeTypeOf("string");
  });

  it("does not forward a non-string err.code either (defensive -- a code should never be anything else, but the allowlist must not choke on it)", () => {
    const res = createResponse();
    const err = new Error("boom");
    err.code = 500;

    apiErrorHandler(err, { method: "GET", path: "/api/some-route" }, res, vi.fn());

    expect(res.json.mock.calls[0][0]).not.toHaveProperty("code");
  });
});

describe("handlePanelUpdateDownload: downloadUpdate()'s result reaches res.json() intact", () => {
  function createRequest(checker) {
    return {
      body: {},
      app: { get: (key) => (key === "panelUpdateChecker" ? checker : undefined) },
    };
  }

  it("already_downloading: code survives to the named 409 branch", async () => {
    const res = createResponse();
    const checker = {
      dockerUpdateProxy: { enabled: false },
      downloadUpdate: vi.fn(async () => ({
        success: false,
        error: "Download already in progress",
        code: "already_downloading",
      })),
    };

    await handlePanelUpdateDownload(createRequest(checker), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "already_downloading" }),
    );
  });

  it("no_update: code survives to the named 400 branch", async () => {
    const res = createResponse();
    const checker = {
      dockerUpdateProxy: { enabled: false },
      downloadUpdate: vi.fn(async () => ({
        success: false,
        error: "No update available",
        code: "no_update",
      })),
    };

    await handlePanelUpdateDownload(createRequest(checker), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "no_update" }),
    );
  });

  it("docker_updater_not_configured: code survives to the generic fallback branch (currently unreachable via downloadUpdate()'s own guard -- see comment above)", async () => {
    const res = createResponse();
    const checker = {
      dockerUpdateProxy: { enabled: false },
      downloadUpdate: vi.fn(async () => ({
        success: false,
        error: "Docker update controller is not configured",
        code: "docker_updater_not_configured",
      })),
    };

    await handlePanelUpdateDownload(createRequest(checker), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "docker_updater_not_configured" }),
    );
  });

  it("success: the result object (no code) still passes through unmodified", async () => {
    const res = createResponse();
    const checker = {
      dockerUpdateProxy: { enabled: false },
      downloadUpdate: vi.fn(async () => ({ success: true, version: "1.2.3" })),
    };

    await handlePanelUpdateDownload(createRequest(checker), res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, version: "1.2.3" });
  });
});
