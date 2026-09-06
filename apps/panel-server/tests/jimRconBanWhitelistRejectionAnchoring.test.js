import { describe, expect, it } from "vitest";
import { RconService } from "../services/rcon.js";

// hunt-wave11-2026-08-29, follow-up to the B42 jar audit's Pass 4 and the
// earlier
// fix, banuser / unbanuser / adduser / removeuserfromwhitelist STILL
// reported a failure as a success -- each command's own class carries no
// rejection text of its own; it all lives in zombie/network/BanSystem and
// zombie/network/ServerWorldDatabase, which Kevin traced and this file
// covers. SAME convention as Pam's linuxPlayersRconRejectionAnchoring.test.js
// throughout -- one new pattern style would be exactly the "four consumers
// phrasing the same thing four ways" state two of tonight's bugs came from.
//
// New pattern sourcing: server/__fixtures__/pzRconRejectionStrings.json
// (decompiled PZ B42 server jar, build 24909800, same fixture Pam's patterns
// are cross-checked against -- extended 69 -> 72 classes for this pass).
// Automatically cross-checked by rconRejectionGroundTruth.test.js's drift
// gate; this file only owns the discrimination property (does a real
// success still classify as success), not re-proving the strings are real.
//
// This is the positive control god's card specifically required: feeding
// only the real rejection strings proves the classifier fires; feeding a
// GENUINE success response (Kevin's own confirmed success shapes: "User X
// is now banned/unbanned", "User X created with/without password", "User X
// removed from white list") whose interpolated name CONTAINS a rejection
// fragment proves it still DISCRIMINATES. Testing only the first half would
// be indistinguishable from a classifier that catches everything.

describe("classifyRconResponse: the new ban/whitelist rejections fire", () => {
  const rcon = new RconService();

  it.each([
    ["banuser: target protected (CantBeBannedByUser)", "This user can't be banned."],
    [
      "banuser -ip: target is behind Steam Relay, no real IP to ban",
      "Cannot ban IP 203.0.113.5 (Steam Relay shared address). Use bansteamid or banuser instead.",
    ],
    [
      "banuser -ip: target's real IP genuinely unavailable",
      "Cannot ban IP for player 'Bob' (Steam Relay, real IP unavailable). Use bansteamid or banuser without -ip.",
    ],
    ["adduser: username already whitelisted", "A user with this name already exists"],
    [
      "unbanuser/removeuserfromwhitelist: target never whitelisted at all",
      'User "Bob" is not in the whitelist, use /adduser first',
    ],
    ["ban/whitelist: target username not found", "User Bob not found"],
    [
      "banuser/unbanuser: RCON account lacks the underlying ban/unban capability",
      "You don't have capability to ban/unban users.",
    ],
  ])("%s", (_label, response) => {
    expect(rcon.classifyRconResponse(response)).not.toBeNull();
  });
});

describe("classifyRconResponse: a griefer's own name must not turn a genuine ban/whitelist SUCCESS into a reported failure", () => {
  const rcon = new RconService();

  it.each([
    // ban/unban success (Kevin's Pass 4): "User <name> is now banned/unbanned"
    ["ban success, name = \"This user can't be banned.\"", "User This user can't be banned. is now banned"],
    [
      "ban success, name = the IP-ban Steam-Relay fragment",
      "User Cannot ban IP for player 'x' (Steam Relay, real IP unavailable). Use bansteamid or banuser without -ip. is now banned",
    ],
    [
      "unban success, name = the no-capability fragment",
      "User You don't have capability to ban/unban users. is now unbanned",
    ],
    // adduser success: "User <name> created with/without password"
    [
      "adduser success, name = 'A user with this name already exists'",
      "User A user with this name already exists created with password",
    ],
    // removeuserfromwhitelist success: "User <name> removed from white list"
    [
      "removeuserfromwhitelist success, name = the not-whitelisted fragment",
      'User User "x" is not in the whitelist, use /adduser first removed from white list',
    ],
    [
      "removeuserfromwhitelist success, name = 'not found'",
      "User not found removed from white list",
    ],
  ])("%s", (_label, response) => {
    expect(rcon.classifyRconResponse(response)).toBeNull();
  });
});

// Named as a number, not implied to be zero: Kevin's Pass 4 also found
// "Connection not found" and "Player not found" as bare literals in
// BanSystem.class, but rated them LOW confidence -- "plausible RCON-reply
// shape but could equally be internal-console-only text", not attributed to
// any ban/unban call site. Deliberately NOT added to KNOWN_RCON_REJECTIONS
// (inventing an attribution would be worse than leaving them out, the same
// standard Pam's original commit held for these same four commands). This
// proves the residual is real and current, not a stale claim: 2 rejection
// shapes for banuser/unbanuser/adduser/removeuserfromwhitelist remain
// genuinely unrecognized after this fix.
describe("classifyRconResponse: the documented residual (2 LOW-confidence strings, not yet added)", () => {
  const rcon = new RconService();

  it.each([
    ["BanSystem.class: 'Connection not found' -- not added, LOW confidence", "Connection not found"],
    ["BanSystem.class: 'Player not found' -- not added, LOW confidence", "Player not found"],
  ])("%s currently reports as success (unrecognized, by design)", (_label, response) => {
    expect(rcon.classifyRconResponse(response)).toBeNull();
  });
});
