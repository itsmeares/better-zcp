import { describe, expect, it, vi } from "vitest";

const { getActiveServer } = vi.hoisted(() => ({
  getActiveServer: vi.fn(),
}));

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
}));

vi.mock("../services/remoteConfigFiles.js", () => ({
  SFTP_CONFIG_PATH_KEY: "panelBridgeSftpConfigPath",
  acquireMirrorLock: vi.fn(),
  beginRemoteConfigSession: vi.fn(),
  getMirrorPath: vi.fn(),
  isRemoteConfigConfigured: vi.fn(() => false),
  pushRemoteConfigFiles: vi.fn(),
  validateRemoteConfigTransport: vi.fn(),
}));

const { applySandboxChanges, parseSandboxVars } = await import("../routes/serverFiles.js");

describe("sandbox nested table preservation", () => {
  const content = [
    "SandboxVars = {",
    "    VERSION = 4,",
    "    Zombies = 3,",
    "    Music = {",
    "        StrengthMultiplier = 2,",
    "    },",
    "    Debug = {",
    "        CheatMode = false,",
    "    },",
    "}",
  ].join("\n");

  it("parses Music and Debug as nested tables rather than top-level settings", () => {
    const sandbox = parseSandboxVars(content);

    expect(sandbox.Music.StrengthMultiplier).toBe(2);
    expect(sandbox.Debug.CheatMode).toBe(false);
    expect(sandbox.settings.StrengthMultiplier).toBeUndefined();
    expect(sandbox.settings.CheatMode).toBeUndefined();
  });

  it("preserves Music and Debug tables when a top-level setting is saved", () => {
    const updated = applySandboxChanges(content, { settings: { Zombies: 1 } });

    expect(updated).toContain("Music = {\n        StrengthMultiplier = 2,\n    },");
    expect(updated).toContain("Debug = {\n        CheatMode = false,\n    },");
    expect(updated).toContain("Zombies = 1,");
  });
});