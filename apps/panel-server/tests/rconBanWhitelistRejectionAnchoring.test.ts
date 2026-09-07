import { describe, expect, it } from "vitest";
import { RconService } from "../services/rcon.ts";


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
    ["ban success, name = \"This user can't be banned.\"", "User This user can't be banned. is now banned"],
    [
      "ban success, name = the IP-ban Steam-Relay fragment",
      "User Cannot ban IP for player 'x' (Steam Relay, real IP unavailable). Use bansteamid or banuser without -ip. is now banned",
    ],
    [
      "unban success, name = the no-capability fragment",
      "User You don't have capability to ban/unban users. is now unbanned",
    ],
    [
      "adduser success, name = 'A user with this name already exists'",
      "User A user with this name already exists created with password",
    ],
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

describe("classifyRconResponse: the documented residual (2 LOW-confidence strings, not yet added)", () => {
  const rcon = new RconService();

  it.each([
    ["BanSystem.class: 'Connection not found' -- not added, LOW confidence", "Connection not found"],
    ["BanSystem.class: 'Player not found' -- not added, LOW confidence", "Player not found"],
  ])("%s currently reports as success (unrecognized, by design)", (_label, response) => {
    expect(rcon.classifyRconResponse(response)).toBeNull();
  });
});
