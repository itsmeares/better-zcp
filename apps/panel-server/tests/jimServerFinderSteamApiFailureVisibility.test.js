import { describe, expect, it } from "vitest";
import { deriveSteamApiFailureReason } from "../routes/serverFinder.js";

// hunt-wave11-2026-08-29 follow-up: when the Steam Web API path throws AND
// the master-server fallback also comes up empty, apiError.message used to
// only reach log.warn -- the caller got source:'master_server' plus an
// emptyReason and nothing about the actual cause. "An admin can read the
// server logs" was the exact reasoning that left three other bugs tonight
// invisible for months, so this is now surfaced on the response instead,
// following the same undefined-unless-relevant convention as
// deriveEmptyReason/deriveMasterDiscoveryStats in the same file.

describe("deriveSteamApiFailureReason", () => {
  it("is undefined when there was no Steam API error at all", () => {
    expect(
      deriveSteamApiFailureReason({ steamApiError: null, serversFound: 0 }),
    ).toBeUndefined();
  });

  it("is undefined when the Steam API errored but the master-server fallback still found servers -- the operator got a working list", () => {
    expect(
      deriveSteamApiFailureReason({
        steamApiError: "Steam API request failed: 503",
        serversFound: 5,
      }),
    ).toBeUndefined();
  });

  it("surfaces the sanitized message when the Steam API errored AND the fallback also came up empty", () => {
    expect(
      deriveSteamApiFailureReason({
        steamApiError: "Steam API request failed: 503",
        serversFound: 0,
      }),
    ).toBe("Steam API request failed: 503");
  });

  it("redacts a filesystem path the same way every other error response in this codebase does", () => {
    expect(
      deriveSteamApiFailureReason({
        steamApiError: "ENOENT: no such file or directory, open 'C:\\data\\panel-config.json'",
        serversFound: 0,
      }),
    ).not.toContain("C:\\data");
  });
});
