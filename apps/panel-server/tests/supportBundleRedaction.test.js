import { describe, expect, it } from "vitest";
import { Readable } from "stream";
import { createServer, setSetting } from "../database/init.js";
import { writeUiSecretFile } from "../utils/uiSecretFile.js";
import {
  redactRawLogText,
  collectBundleKnownSecrets,
  createRedactingLogStream,
} from "../routes/debug.js";

// support-bundle-2026-08-30 follow-up (operator ruling): the four
// pre-existing raw-log categories (admin-panel, zomboid-server,
// zomboid-install, crash-logs) and the two added the same night
// (docker-container-logs.txt, managed-service-logs.txt) must ALL be
// redacted for known credential shapes -- uniformly, not a subset -- and
// the redaction must never be aggressive enough to eat the diagnostic
// content the bundle exists to preserve. See debug.js's redactRawLogText
// header for the two-layer design this file exercises.

// The exact line (Discord #bug_report, Rhazun) that made the
// Docker/systemd log capture feature worth building in the first place --
// see hive/agents/god/research/discord-restart-etxtbsy-2026-08-30.md. If a
// redaction rule ever touches this line, it has destroyed the one piece of
// evidence that made tonight's earlier fix possible.
const ETXTBSY_STACK_TRACE_LINE =
  "System.IO.IOException: Text file busy : '/project-zomboid/jre64/bin/java'";

describe("redactRawLogText() -- must never mangle ordinary diagnostic text", () => {
  it("leaves the exact ETXTBSY stack trace line that motivated this feature completely untouched", () => {
    expect(redactRawLogText(ETXTBSY_STACK_TRACE_LINE, [])).toBe(
      ETXTBSY_STACK_TRACE_LINE,
    );
    // Also survives with real known secrets loaded, not just an empty list.
    expect(
      redactRawLogText(ETXTBSY_STACK_TRACE_LINE, ["hunter2", "some-token-value"]),
    ).toBe(ETXTBSY_STACK_TRACE_LINE);
  });

  it("leaves an ordinary Java stack trace with file paths and quotes intact", () => {
    const line =
      'java.lang.RuntimeException: Failed to load "C:\\Servers\\pz\\Server\\test.ini" (exists=true)';
    expect(redactRawLogText(line, ["hunter2"])).toBe(line);
  });

  it("leaves plain unrelated log lines untouched", () => {
    const line = "[2026-08-30T12:00:00Z] INFO: Server started on port 16261";
    expect(redactRawLogText(line, [])).toBe(line);
  });
});

describe("redactRawLogText() -- known-secret-value exact match", () => {
  it("redacts an exact occurrence of a known RCON password", () => {
    const result = redactRawLogText(
      "RCON login attempt with password hunter2 rejected",
      ["hunter2"],
    );
    expect(result).toBe("RCON login attempt with password [REDACTED] rejected");
  });

  it("redacts every known secret independently in the same line", () => {
    const result = redactRawLogText(
      "rcon=alpha discord=beta sftp=gamma",
      ["alpha", "beta", "gamma"],
    );
    expect(result).toBe("rcon=[REDACTED] discord=[REDACTED] sftp=[REDACTED]");
  });

  it("is a no-op when no known secrets are supplied", () => {
    expect(redactRawLogText("nothing sensitive here", [])).toBe(
      "nothing sensitive here",
    );
  });
});

describe("redactRawLogText() -- shape-based patterns for what a known-value scrub structurally can't catch", () => {
  it("redacts the RCON adduser-with-password shape (a player's own whitelist password, never a stored 'known' secret)", () => {
    const line = 'executing: adduser "bob" "swordfish123"';
    const result = redactRawLogText(line, []);
    expect(result).toBe('executing: adduser "bob" "[REDACTED]"');
  });

  it("redacts a Discord-bot-token-shaped string even when it is not in the known-secrets list (e.g. a rotated token)", () => {
    // Deliberately low-entropy/repeated-character rather than random-looking:
    // an earlier version of this fixture used a first segment that legitimately
    // base64-decoded to an 18-digit number (a plausible Discord snowflake ID),
    // which is realistic enough that GitHub push protection blocked the commit
    // as a live Discord bot token (verified not real; see the commit history
    // for this file). GitHub's detector validates structure -- the first
    // segment decoding to a plausible snowflake -- not just the three-segment
    // dot shape, so this fixture is chosen to satisfy OUR shape regex (which
    // only checks charset/length/dot-count) while failing THAT check: 24
    // repeated 'x' bytes base64-decode to non-numeric garbage, never a
    // plausible snowflake. Confirmed still exercises the real code path --
    // this must keep failing if redactRawLogText's Discord-token branch is
    // ever removed or narrowed.
    const line =
      "Discord login failed for token xxxxxxxxxxxxxxxxxxxxxxxx.yyyyyy.zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    const result = redactRawLogText(line, []);
    expect(result).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxx.yyyyyy.zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz");
    expect(result).toContain("[REDACTED-DISCORD-TOKEN]");
  });

  it("redacts the Steam Web API key out of a GetServerList request URL, keeping the rest of the URL readable", () => {
    const line =
      "fetch failed: https://api.steampowered.com/IGameServersService/GetServerList/v1/?key=0123456789abcdef0123456789abcdef&filter=\\appid\\108600&limit=10";
    const result = redactRawLogText(line, []);
    expect(result).not.toContain("0123456789abcdef0123456789abcdef");
    expect(result).toContain("?key=[REDACTED]");
    expect(result).toContain("GetServerList/v1/");
  });

  it("does not touch a bare alphanumeric string that merely happens to be long, outside a ?key=/&key= context", () => {
    const line = "session id: 0123456789abcdef0123456789abcdef (not a URL)";
    expect(redactRawLogText(line, [])).toBe(line);
  });
});

describe("collectBundleKnownSecrets() -- assembles the real secret superset for this bundle", () => {
  it("includes a per-server RCON password, a Discord bot token, and a Steam API key together", async () => {
    await createServer({
      name: "RedactionTestServer",
      serverName: "RedactionTestServer",
      installPath: "/srv/pz",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      rconPassword: "bundle-rcon-secret",
      serverPort: 16261,
    });
    writeUiSecretFile("discordBotToken", "bundle-discord-secret");
    await setSetting("steamApiKey", "bundle-steam-api-secret");

    const secrets = await collectBundleKnownSecrets();

    expect(secrets).toContain("bundle-rcon-secret");
    expect(secrets).toContain("bundle-discord-secret");
    expect(secrets).toContain("bundle-steam-api-secret");
  });

  it("never throws when nothing is configured yet -- a fresh install must still produce a (empty) bundle", async () => {
    await expect(collectBundleKnownSecrets()).resolves.toEqual(
      expect.any(Array),
    );
  });
});

describe("createRedactingLogStream() -- streams a raw log file through the same redaction, without buffering it whole", () => {
  async function collectStream(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
  }

  it("redacts a known secret that arrives in a single chunk", async () => {
    const source = Readable.from(["password=hunter2 accepted\n"]);
    const out = await collectStream(source.pipe(createRedactingLogStream(["hunter2"])));
    expect(out).toBe("password=[REDACTED] accepted\n");
  });

  it("redacts a secret split across two chunk boundaries, since it buffers by line not by chunk", async () => {
    const source = Readable.from(["password=hunt", "er2 accepted\n"]);
    const out = await collectStream(source.pipe(createRedactingLogStream(["hunter2"])));
    expect(out).toBe("password=[REDACTED] accepted\n");
  });

  it("flushes a final line with no trailing newline", async () => {
    const source = Readable.from(["password=hunter2"]);
    const out = await collectStream(source.pipe(createRedactingLogStream(["hunter2"])));
    expect(out).toBe("password=[REDACTED]");
  });

  it("leaves the ETXTBSY stack trace line intact when streamed", async () => {
    const source = Readable.from([ETXTBSY_STACK_TRACE_LINE + "\n"]);
    const out = await collectStream(source.pipe(createRedactingLogStream(["hunter2"])));
    expect(out).toBe(ETXTBSY_STACK_TRACE_LINE + "\n");
  });
});
