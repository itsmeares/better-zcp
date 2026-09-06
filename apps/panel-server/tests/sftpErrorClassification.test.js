import { describe, expect, it, vi } from "vitest";

// 2026-08-26: formatSftpError()/getSftpErrorGuidance() (panelBridgeSftp.js)
// already classified an SFTP failure correctly and appended a tailored
// English "Fix: ..." sentence, but that classification never fed into
// errorCodes.js/errors.json -- every non-English user saw the raw English
// sentence regardless of locale. This locks in that POST /panel-bridge/
// sftp/test now sends `code` + `params.detail` alongside the unchanged
// English `error` fallback, so an updated client can show the exact same
// classification translated, with the original error text preserved via
// {{detail}} instead of replaced by a vaguer generic sentence.

vi.mock("../database/init.js", () => ({
  getAllSettings: vi.fn(async () => ({})),
  getServer: vi.fn(),
  getActiveServer: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand: vi.fn(),
  setSetting: vi.fn(async () => {}),
}));

vi.mock("../services/panelBridgeSftp.js", async () => {
  const actual = await vi.importActual("../services/panelBridgeSftp.js");
  return {
    ...actual,
    testSftpBridge: vi.fn(async () => {
      throw new Error("Permission denied (publickey).");
    }),
  };
});

const router = (await import("../routes/panelBridge.js")).default;
const { ErrorCode } = await import("../utils/errorCodes.js");

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

function getTestSftpHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/sftp/test" && entry.route.methods.post,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe("POST /api/panel-bridge/sftp/test error classification", () => {
  it("sends a registered SFTP error code with the original message as params.detail", async () => {
    const req = { body: { host: "pz.example.net", port: 22, username: "u", password: "p", bridgePath: "/home/pz/Zomboid/Lua/panelbridge/Test" } };
    const res = createResponse();

    await getTestSftpHandler()(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe(ErrorCode.SFTP_AUTH_FAILED);
    expect(res.body.params).toEqual({ detail: "Permission denied (publickey)." });
    // The English fallback must still read exactly as it did before this
    // classification existed, for any client that doesn't read `code` yet.
    expect(res.body.error).toBe(
      "Permission denied (publickey). Fix: Verify the SFTP username and password, then confirm the account can log in over port 22.",
    );
  });
});
