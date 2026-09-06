import { describe, expect, it, vi } from "vitest";

// hunt-wave5-2026-08-29 suspect 5: can an RCON password, a file path, or a
// token fragment reach a Discord message? god's framing, verbatim: "Check a
// FAILURE message, not a success one -- error paths are where secrets get
// interpolated by accident, because nobody writes an error string expecting
// it to be published."
//
// The one real interpolation site, traced by hand across three files:
// utils/sourceRcon.js's low-level execute() embeds the raw admin-typed
// command into its own timeout error --
//   reject(new Error(`RCON command timed out: ${command}`))
// -- so a slash-command admin running something like
// "adduser bob fake-rcon-password-for-test-only" that happens to hit this
// 8s internal timeout produces an Error whose .message contains the
// password verbatim.
//
// This file proves (not just reads) that message never survives to reach
// Discord, via TWO INDEPENDENT layers -- both real, unmocked code:
//
//   1. services/rcon.js's execute() never even hands that message to its
//      own getUserFriendlyError() classifier. Every branch that CAN see
//      "timed out" in errorMsg routes into the reconnect-and-retry path
//      instead (isConnectionError check), which produces an entirely
//      different result object (a fresh reconnect error, or the RETRIED
//      command's own response) -- the original interpolated string is
//      discarded, not surfaced.
//   2. Even if some future code path called getUserFriendlyError() with
//      that raw string directly, its own "timed out" substring match fires
//      before the generic errorMsg-passthrough fallback, replacing it with
//      a static, secret-free message.
//
// Belt AND suspenders, not one lucky guard -- and the outer layer
// (services/discordBot.js's handleRcon(), the file this hunt owns) is
// exercised end to end too, through sanitizeError(), to prove the actual
// Discord-bound reply text is clean.
//
// Explicitly NOT in scope here, and not investigated further, because god's
// ask was specifically about a FAILURE message: handleRcon()'s SUCCESS
// branch includes the raw RCON response verbatim (only backtick-escaped,
// no secret-aware sanitization at all) -- if some future command's
// response text happened to echo a secret, that path has no equivalent
// protection. Noting this precisely rather than silently expanding scope
// to fix it, same discipline as this hunt's earlier suspect-6 report-only
// finding.

// Deliberately does NOT contain the literal substring "password" -- a
// realistic secret value wouldn't reliably contain that word either, and
// getUserFriendlyError() has its OWN separate classifier for the word
// "password" (line ~1136) that would otherwise silently absorb this test's
// signal and hide whether the "timed out" guards specifically are doing
// their job. Caught this confound empirically during break-verify (see
// the hunt report) before it could produce a misleadingly-passing test.
const FAKE_PASSWORD = "fake-rcon-secret-hunter2-for-test-only";

vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async () => null,
  setSetting: async () => {},
  logCommand: () => {},
}));

const { RconService } = await import("../services/rcon.js");
const { DiscordBot } = await import("../services/discordBot.js");

describe("layer 1 -- RconService.getUserFriendlyError() neutralizes an interpolated timeout message on contact", () => {
  it("a raw sourceRcon.js-shaped timeout message containing the password never survives the classifier", () => {
    const service = new RconService();
    const raw = `RCON command timed out: adduser bob ${FAKE_PASSWORD}`;
    const friendly = service.getUserFriendlyError(raw);

    expect(friendly).not.toContain(FAKE_PASSWORD);
    expect(friendly).toBe(
      "Connection timed out. Server may be unresponsive or firewall is blocking.",
    );
  });
});

describe("layer 2 -- RconService.execute() routes a timed-out command away from the caller entirely, real reconnect logic included", () => {
  function makeService({ reconnectSucceeds }) {
    const service = new RconService();
    service.connected = true;
    service.serverStarting = false;
    const command = `adduser bob ${FAKE_PASSWORD}`;
    // The exact rejection shape sourceRcon.js's own 8s internal timeout
    // produces -- see utils/sourceRcon.js execute(), line ~245.
    service.client = {
      execute: () => Promise.reject(new Error(`RCON command timed out: ${command}`)),
    };
    service.reconnect = reconnectSucceeds
      ? async () => {
          service.connected = true;
          // A successful retry after reconnection -- a normal, unrelated
          // server reply, standing in for "the retried command went
          // through fine the second time."
          service.client = { execute: async () => "Player added successfully" };
          return true;
        }
      : async () => {
          service.connected = false;
          throw new Error("RCON reconnection failed: ECONNREFUSED");
        };
    return { service, command };
  }

  it("reconnect succeeds after the timeout -- the retried result carries no trace of the original password-bearing message", async () => {
    const { service, command } = makeService({ reconnectSucceeds: true });
    const result = await service.execute(command, {
      retryOnConnectionError: true,
    });

    expect(JSON.stringify(result)).not.toContain(FAKE_PASSWORD);
    expect(result).toEqual({ success: true, response: "Player added successfully" });
  });

  it("reconnect fails after the timeout -- the returned error is the RECONNECT failure, not the original timeout message", async () => {
    const { service, command } = makeService({ reconnectSucceeds: false });
    const result = await service.execute(command, {
      retryOnConnectionError: true,
    });

    expect(JSON.stringify(result)).not.toContain(FAKE_PASSWORD);
    expect(result.success).toBe(false);
    // Confirms it's genuinely the RECONNECT error surfacing (classified via
    // its own ECONNREFUSED), not a coincidental empty string or a leftover
    // of the original message -- the test would be worthless if this
    // assertion couldn't tell the two apart.
    expect(result.error).toBe(
      "Cannot connect to server. Is the game server running with RCON enabled?",
    );
  });
});

describe("layer 3 -- DiscordBot.handleRcon() end to end: the actual Discord-bound reply text is clean", () => {
  function makeFakeInteraction(command) {
    return {
      options: { getString: () => command },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("a command that times out internally (password included) never appears in what gets posted to Discord", async () => {
    const command = `adduser bob ${FAKE_PASSWORD}`;
    const rconService = {
      connected: true,
      sanitize: (input) => String(input), // no quotes/backslashes in this command, passthrough is faithful
      execute: async () => {
        // Real RconService.execute()'s own output shape for this exact
        // scenario, per layer 2 above -- reconnect fails, so a generic
        // reconnection-failure message comes back, never the original.
        const service = new RconService();
        service.connected = true;
        service.client = {
          execute: () => Promise.reject(new Error(`RCON command timed out: ${command}`)),
        };
        service.reconnect = async () => {
          throw new Error("RCON reconnection failed: ECONNREFUSED");
        };
        return service.execute(command, { retryOnConnectionError: true });
      },
    };
    const bot = new DiscordBot(rconService, null, null, null);
    const interaction = makeFakeInteraction(command);

    await bot.handleRcon(interaction);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const posted = interaction.editReply.mock.calls[0][0];
    const postedText = typeof posted === "string" ? posted : JSON.stringify(posted);
    expect(postedText).not.toContain(FAKE_PASSWORD);
    expect(postedText).toContain("Error");
  });
});
