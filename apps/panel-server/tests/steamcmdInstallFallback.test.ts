import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configuredSteamCmdPath = { value: null as string | null };

vi.mock("../database/init.ts", () => ({
  getSetting: vi.fn(async (key: string) =>
    key === "steamcmdPath" ? configuredSteamCmdPath.value : null,
  ),
  setSetting: vi.fn(async () => undefined),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  logServerEvent: vi.fn(async () => undefined),
}));

vi.mock("../routes/chunks.ts", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { default: router, STEAMCMD_FIXED_CANDIDATE_PATHS } = await import(
  "../routes/server.ts"
);

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getInstallHandler() {
  const layer = router.stack.find(
    (entry: any) => entry.route?.path === "/install" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

let root: string;
let installPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-steam-install-"));
  installPath = path.join(root, "server");
  configuredSteamCmdPath.value = null;
  delete process.env.STEAMCMD_PATH;
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeFakeSteamCmd(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  const executable = path.join(
    directory,
    process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh",
  );
  fs.writeFileSync(executable, "");
}

describe("POST /install SteamCMD detection", () => {
  it("uses the existing detection path when steamcmdPath is omitted", async () => {
    const detectedPath = path.join(root, "detected-steamcmd");
    writeFakeSteamCmd(detectedPath);
    configuredSteamCmdPath.value = detectedPath;

    const response = createResponse();
    await getInstallHandler()(
      { app: { get: () => ({ emit: vi.fn() }) }, body: { installPath, serverName: "bad/name" } },
      response,
    );

    expect(response.json.mock.calls[0][0].code).toBe("SERVER_NAME_FORMAT_INVALID");
  });

  it("keeps an explicit path ahead of automatic detection", async () => {
    configuredSteamCmdPath.value = path.join(root, "detected-steamcmd");
    writeFakeSteamCmd(configuredSteamCmdPath.value);

    const response = createResponse();
    await getInstallHandler()(
      {
        app: { get: () => ({ emit: vi.fn() }) },
        body: { steamcmdPath: "relative/path", installPath, serverName: "TestServer" },
      },
      response,
    );

    expect(response.json.mock.calls[0][0].code).toBe("STEAMCMD_PATH_INVALID");
  });

  it("explains where detection looked when no SteamCMD is available", async () => {
    const response = createResponse();
    await getInstallHandler()(
      { app: { get: () => ({ emit: vi.fn() }) }, body: { installPath, serverName: "TestServer" } },
      response,
    );

    const payload = response.json.mock.calls[0][0];
    expect(payload.code).toBe("INSTALL_MISSING_FIELDS");
    expect(payload.error).toContain("steamcmdPath");
    for (const candidate of STEAMCMD_FIXED_CANDIDATE_PATHS) {
      expect(payload.error).toContain(candidate);
    }
  });
});
