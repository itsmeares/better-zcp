import { describe, expect, it } from "vitest";
import { RconService } from "../services/rcon.js";


describe("classifyRconResponse: real rejections still fire after anchoring", () => {
  const rcon = new RconService();

  it.each([
    ["kickuser: target not connected", "User Bob doesn't exist."],
    ["kickuser: target protected", "This user can't be kicked."],
    ["additem/addxp/teleport/teleportplayer/addvehicle/voiceban: target not connected", "No such user"],
    ["setaccesslevel: bad username", 'Invalid username "Bob"'],
    ["setaccesslevel: bad level name", "Access Level 'overseer2' unknown, list of access level: admin,moderator,overseer,gm,observer,user"],
    ["setaccesslevel: role-hierarchy denial", "You do not have sufficient rights to set this access level."],
    ["setaccesslevel: target has no account", 'User "Bob" is not in the whitelist nor the server, use /adduser first'],
  ])("%s", (_label, response) => {
    expect(rcon.classifyRconResponse(response)).not.toBeNull();
  });
});

describe("classifyRconResponse: a griefer's own display name must not turn their SUCCESSFUL command into a reported failure", () => {
  const rcon = new RconService();

  it.each([
    ["kickuser success, name = 'Not enough rights'", "User Not enough rights kicked."],
    ["kickuser success, name = 'Wrong arguments!'", "User Wrong arguments! kicked."],
    ["kickuser success, name = 'No such user'", "User No such user kicked."],
    ["kickuser success, name literally containing 'doesn't exist.'", "User Steve doesn't exist. kicked."],
    ["setaccesslevel success, name = 'Not enough rights'", "Not enough rights granted admin access level on MyServer"],
    ["setaccesslevel success, name = 'Invalid username \"x\"'", 'Invalid username "x" granted admin access level on MyServer'],
    ["setaccesslevel success, name containing the whitelist-rejection fragment", 'User "x" is not in the whitelist nor the server, use /adduser first granted admin access level on MyServer'],
  ])("%s", (_label, response) => {
    expect(rcon.classifyRconResponse(response)).toBeNull();
  });
});

describe("classifyRconResponse: unrelated informative responses are untouched", () => {
  const rcon = new RconService();

  it("does not classify a normal player list as a rejection", () => {
    expect(rcon.classifyRconResponse("Players connected (2):\n-Alice\n-Bob")).toBeNull();
  });
});
