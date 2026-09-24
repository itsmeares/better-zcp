import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getActiveServerContext } = vi.hoisted(
  () => ({
    getActiveServerContext: vi.fn(),
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

const { maskSecretValue } = await import("../utils/sanitize.ts");
const { default: router } = await import("../routes/serverFiles.ts");
const saveIni = router.stack.find((entry) =>
  entry.route?.path === "/ini" && entry.route.methods.put,
)?.route?.stack.at(-1)?.handle;

async function execute(body: Record<string, unknown>) {
  if (!saveIni) throw new Error("INI route missing");
  const response = {
    statusCode: 200,
    body: null as any,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
  await saveIni({ body } as any, response as any, () => {});
  return response;
}

describe("structured INI API route", () => {
  let configDir: string;
  let iniPath: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ini-route-"));
    iniPath = path.join(configDir, "TestServer.ini");
    fs.writeFileSync(
      iniPath,
      "PVP=true\nRCONPassword=live-rcon-secret\nPassword=live-join-secret\n",
    );
    getActiveServerContext.mockResolvedValue({
      serverConfigPath: configDir,
      serverName: "TestServer",
      activeServer: {},
    });
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("preserves masked secrets while writing the structured INI", async () => {
    const result = await execute({
        settings: {
          PVP: "false",
          RCONPassword: maskSecretValue("live-rcon-secret"),
          Password: maskSecretValue("live-join-secret"),
        },
      });

    expect(fs.readFileSync(iniPath, "utf8")).toBe(
      "PVP=false\nRCONPassword=live-rcon-secret\nPassword=live-join-secret\n",
    );
    expect(result.statusCode).toBe(200);
    expect(result.body.settings.RCONPassword).toBe(
      maskSecretValue("live-rcon-secret"),
    );
    expect(JSON.stringify(result.body)).not.toContain("live-rcon-secret");
  });

  it("refuses structured saves when duplicate INI keys would be discarded", async () => {
    fs.writeFileSync(iniPath, "PVP=true\nPublicName=First\nPublicName=Second\n");

    const result = await execute({ settings: { PVP: "false" } });
    expect(result.statusCode).toBe(409);
    expect(result.body.code).toBe("INI_DUPLICATE_KEY_BLOCKS_STRUCTURED_SAVE");
    expect(fs.readFileSync(iniPath, "utf8")).toContain("PVP=true");
  });
});
