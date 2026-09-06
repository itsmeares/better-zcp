import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createServer = vi.fn();

vi.mock("../database/init.js", () => ({
  getServers: vi.fn(),
  getServer: vi.fn(),
  getActiveServer: vi.fn(),
  createServer,
  updateServer: vi.fn(),
  deleteServer: vi.fn(),
  setActiveServer: vi.fn(),
}));

const { default: router } = await import("../routes/servers.js");

const ORIGINAL_SERVER_PATH = process.env.PZ_SERVER_PATH;
const ORIGINAL_SAVE_PATH = process.env.PZ_SAVE_PATH;

function restoreEnv() {
  if (ORIGINAL_SERVER_PATH === undefined) delete process.env.PZ_SERVER_PATH;
  else process.env.PZ_SERVER_PATH = ORIGINAL_SERVER_PATH;
  if (ORIGINAL_SAVE_PATH === undefined) delete process.env.PZ_SAVE_PATH;
  else process.env.PZ_SAVE_PATH = ORIGINAL_SAVE_PATH;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

// POST / now has requireRole("admin", "technician") ahead of the real
// handler (see roles.test.js for coverage of that gate itself) — grab the
// last stack entry rather than the first, so this keeps working regardless
// of how many gating middlewares precede the handler.
function getCreateHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/" && entry.route.methods.post,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe("POST /api/servers env-var fallback", () => {
  beforeEach(() => {
    createServer.mockReset();
    createServer.mockResolvedValue({ id: "server-id", name: "Test Server" });
  });

  afterEach(restoreEnv);

  it("seeds installPath/zomboidDataPath from env vars when the body omits them", async () => {
    process.env.PZ_SERVER_PATH = "/env/pz-server";
    process.env.PZ_SAVE_PATH = "/env/zomboid-data";
    const response = createResponse();

    await getCreateHandler()(
      {
        body: {
          name: "Test Server",
          rconHost: "127.0.0.1",
          rconPort: 27015,
          rconPassword: "rcon-password",
        },
      },
      response,
    );

    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        installPath: "/env/pz-server",
        zomboidDataPath: "/env/zomboid-data",
      }),
    );
    expect(response.status).toHaveBeenCalledWith(201);
  });

  it("keeps the body-supplied installPath over the env var", async () => {
    process.env.PZ_SERVER_PATH = "/env/pz-server";
    const response = createResponse();

    await getCreateHandler()(
      {
        body: {
          name: "Test Server",
          installPath: "/body/pz-server",
          rconHost: "127.0.0.1",
          rconPort: 27015,
          rconPassword: "rcon-password",
        },
      },
      response,
    );

    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({ installPath: "/body/pz-server" }),
    );
  });
});
