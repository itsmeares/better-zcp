import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getActiveServerContext, getRoleByName, getPanelRuntime } = vi.hoisted(
  () => ({
    getActiveServerContext: vi.fn(),
    getRoleByName: vi.fn(),
    getPanelRuntime: vi.fn(),
  }),
);

vi.mock("../services/sandboxPersistence.ts", () => ({
  getActiveServerContext,
  getServerName: vi.fn(),
  modifySandboxValue: vi.fn(),
  resolveRemoteConfigTransport: vi.fn(),
  RemoteConfigNotConfiguredError: class RemoteConfigNotConfiguredError extends Error {},
  ServerNotConfiguredError: class ServerNotConfiguredError extends Error {},
}));

vi.mock("../database/init.ts", () => ({ getRoleByName }));
vi.mock("../utils/panelRuntime.ts", () => ({ getPanelRuntime }));

const { maskSecretValue } = await import("../utils/sanitize.ts");
const { saveServerIni } = await import(
  "../../panel-client/src/lib/serverFileReads.server.ts"
);

const execute = (saveServerIni as any).__executeImplementation as (
  data: Record<string, unknown>,
  context: Record<string, unknown>,
) => Promise<any>;

describe("Start server-file mutations", () => {
  let configDir: string;
  let iniPath: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "start-file-mutation-"));
    iniPath = path.join(configDir, "TestServer.ini");
    fs.writeFileSync(
      iniPath,
      "PVP=true\nRCONPassword=live-rcon-secret\nPassword=live-join-secret\n",
    );
    getActiveServerContext.mockResolvedValue({
      serverConfigPath: configDir,
      serverName: "TestServer",
      activeServer: { isRemote: false },
    });
    getRoleByName.mockResolvedValue({ capabilities: ["server.configure"] });
    getPanelRuntime.mockReturnValue({
      serverManager: {
        reloadConfig: vi.fn(async () => undefined),
        getServerProcessDetails: vi.fn(async () => ({
          running: false,
          scanFailed: false,
        })),
      },
    });
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("preserves masked secrets while writing the structured INI", async () => {
    const result = await execute(
      {
        settings: {
          PVP: "false",
          RCONPassword: maskSecretValue("live-rcon-secret"),
          Password: maskSecretValue("live-join-secret"),
        },
      },
      { authenticatedUser: { role: "admin" } },
    );

    expect(fs.readFileSync(iniPath, "utf8")).toBe(
      "PVP=false\nRCONPassword=live-rcon-secret\nPassword=live-join-secret\n",
    );
    expect(result.settings.RCONPassword).toBe(
      maskSecretValue("live-rcon-secret"),
    );
    expect(JSON.stringify(result)).not.toContain("live-rcon-secret");
  });

  it("refuses structured saves when duplicate INI keys would be discarded", async () => {
    fs.writeFileSync(iniPath, "PVP=true\nPublicName=First\nPublicName=Second\n");

    await expect(
      execute(
        { settings: { PVP: "false" } },
        { authenticatedUser: { role: "admin" } },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "INI_DUPLICATE_KEY_BLOCKS_STRUCTURED_SAVE",
    });
    expect(fs.readFileSync(iniPath, "utf8")).toContain("PVP=true");
  });
});
