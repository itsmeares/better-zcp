import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


describe("redactKnownSecrets() -- pure redaction logic", () => {
  it("replaces every exact occurrence of a known secret with a placeholder", async () => {
    const { redactKnownSecrets } = await import("../utils/discordMessageRedaction.js");
    const result = redactKnownSecrets(
      "before hunter2 middle hunter2 after",
      ["hunter2"],
    );
    expect(result).toBe("before [REDACTED] middle [REDACTED] after");
  });

  it("redacts a short, common-word secret with no length exemption -- an operator's weak password is still a real secret", async () => {
    const { redactKnownSecrets } = await import("../utils/discordMessageRedaction.js");
    const result = redactKnownSecrets(
      "the access level is admin now",
      ["admin"],
    );
    expect(result).toBe("the access level is [REDACTED] now");
  });

  it("redacts the JSON-string-escaped form too, since this runs on already-serialized request bodies", async () => {
    const { redactKnownSecrets } = await import("../utils/discordMessageRedaction.js");
    const secret = 'pass"word\\with\nspecial';
    const serializedBody = JSON.stringify({ content: `leaked: ${secret}` });
    const result = redactKnownSecrets(serializedBody, [secret]);
    expect(result).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(result).toContain("[REDACTED]");
  });

  it("multiple distinct secrets in the same text are all redacted", async () => {
    const { redactKnownSecrets } = await import("../utils/discordMessageRedaction.js");
    const result = redactKnownSecrets(
      "rcon=alpha discord=beta sftp=gamma",
      ["alpha", "beta", "gamma"],
    );
    expect(result).toBe("rcon=[REDACTED] discord=[REDACTED] sftp=[REDACTED]");
  });

  it("empty/null secret values in the list are skipped, never treated as a match-everything wildcard", async () => {
    const { redactKnownSecrets } = await import("../utils/discordMessageRedaction.js");
    const result = redactKnownSecrets("completely ordinary text", ["", null, undefined]);
    expect(result).toBe("completely ordinary text");
  });

  it("a non-string body (e.g. null, or a FormData for a file upload) passes through untouched", async () => {
    const { redactKnownSecrets } = await import("../utils/discordMessageRedaction.js");
    expect(redactKnownSecrets(null, ["secret"])).toBeNull();
    expect(redactKnownSecrets(undefined, ["secret"])).toBeUndefined();
    const fd = new FormData();
    expect(redactKnownSecrets(fd, ["secret"])).toBe(fd);
  });

  it("an empty secrets list is a no-op, not an error", async () => {
    const { redactKnownSecrets } = await import("../utils/discordMessageRedaction.js");
    expect(redactKnownSecrets("hello world", [])).toBe("hello world");
  });
});

describe("collectKnownSecretValues() -- gathers every secret the panel currently holds", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-discord-redaction-"));
    vi.resetModules();
    vi.doMock("../utils/paths.js", () => ({
      getDataPaths: () => ({ dataDir: tmpDir }),
    }));
  });

  afterEach(() => {
    vi.doUnmock("../utils/paths.js");
    vi.doUnmock("../database/init.js");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("collects a per-server rconPassword for EVERY server, not just the active one", async () => {
    vi.doMock("../database/init.js", () => ({
      getServers: async () => [
        { id: "s1", rconPassword: "rcon-secret-one" },
        { id: "s2", rconPassword: "rcon-secret-two" },
      ],
      getSetting: async () => null,
    }));
    const { collectKnownSecretValues } = await import("../utils/discordMessageRedaction.js");

    const values = await collectKnownSecretValues();

    expect(values).toContain("rcon-secret-one");
    expect(values).toContain("rcon-secret-two");
  });

  it("collects the legacy settings.rconPassword mirror", async () => {
    vi.doMock("../database/init.js", () => ({
      getServers: async () => [],
      getSetting: async (key) => (key === "rconPassword" ? "legacy-mirror-secret" : null),
    }));
    const { collectKnownSecretValues } = await import("../utils/discordMessageRedaction.js");

    const values = await collectKnownSecretValues();

    expect(values).toContain("legacy-mirror-secret");
  });

  it("collects discordBotToken, panelBridgeSftpPassword, steamSessionId, steamLoginSecure from their real secret files", async () => {
    vi.doMock("../database/init.js", () => ({
      getServers: async () => [],
      getSetting: async () => null,
    }));
    const { writeUiSecretFile } = await import("../utils/uiSecretFile.js");
    writeUiSecretFile("discordBotToken", "bot-token-secret");
    writeUiSecretFile("panelBridgeSftpPassword", "sftp-secret");
    writeUiSecretFile("steamSessionId", "steam-session-secret");
    writeUiSecretFile("steamLoginSecure", "steam-login-secure-secret");

    const { collectKnownSecretValues } = await import("../utils/discordMessageRedaction.js");
    const values = await collectKnownSecretValues();

    expect(values).toContain("bot-token-secret");
    expect(values).toContain("sftp-secret");
    expect(values).toContain("steam-session-secret");
    expect(values).toContain("steam-login-secure-secret");
  });

  it("reads a server's join Password LIVE off its own .ini file, not from any cached value -- closes the corner where an operator edited the .ini directly", async () => {
    const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-server-ini-"));
    fs.writeFileSync(
      path.join(serverDir, "servertest.ini"),
      "PVP=false\nPassword=live-ini-join-password\nMaxPlayers=16\n",
    );
    vi.doMock("../database/init.js", () => ({
      getServers: async () => [
        { id: "s1", serverName: "servertest", serverConfigPath: serverDir },
      ],
      getSetting: async () => null,
    }));

    const { collectKnownSecretValues } = await import("../utils/discordMessageRedaction.js");
    const values = await collectKnownSecretValues();

    expect(values).toContain("live-ini-join-password");
    fs.rmSync(serverDir, { recursive: true, force: true });
  });

  it("a missing/unreadable source is skipped, not fatal -- the function still returns everything else it could gather", async () => {
    vi.doMock("../database/init.js", () => ({
      getServers: async () => {
        throw new Error("db unavailable");
      },
      getSetting: async () => null,
    }));
    const { writeUiSecretFile } = await import("../utils/uiSecretFile.js");
    writeUiSecretFile("discordBotToken", "still-collected-token");

    const { collectKnownSecretValues } = await import("../utils/discordMessageRedaction.js");
    const values = await collectKnownSecretValues();

    expect(values).toContain("still-collected-token");
  });

  it("no duplicates when the same value appears from two sources", async () => {
    vi.doMock("../database/init.js", () => ({
      getServers: async () => [{ id: "s1", rconPassword: "shared-value" }],
      getSetting: async (key) => (key === "rconPassword" ? "shared-value" : null),
    }));
    const { collectKnownSecretValues } = await import("../utils/discordMessageRedaction.js");

    const values = await collectKnownSecretValues();

    expect(values.filter((v) => v === "shared-value")).toHaveLength(1);
  });
});
