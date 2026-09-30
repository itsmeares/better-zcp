import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { GameIntegration } from "../services/gameIntegration.ts";
import { installGameIntegration, getGameIntegrationInstallStatus } from "../services/gameIntegrationInstaller.ts";

const roots: string[] = [], games: GameIntegration[] = [];
afterEach(() => { games.forEach((game) => game.stop()); games.length = 0; roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })); });
async function fixture(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "argus-")); roots.push(root);
  const state = { protocol: 1, version: "1.0.0", session: name + "-boot", serverName: name, players: ["Bob"], playerCount: 1, playerDetails: [{ username: "Bob" }], world: {} };
  fs.writeFileSync(path.join(root, "status.json.txt"), JSON.stringify(state));
  const game = new GameIntegration(); games.push(game); game.start(root, name);
  fs.writeFileSync(path.join(root, "status.json.txt"), JSON.stringify(state));
  const stamp = new Date(Date.now() + 5);
  fs.utimesSync(path.join(root, "status.json.txt"), stamp, stamp);
  await expect.poll(() => game.isConnected()).toBe(true);
  return { root, game, state };
}
async function request(root: string) {
  let value: any;
  await expect.poll(() => {
    try { value = JSON.parse(fs.readFileSync(path.join(root, "request.json"), "utf8")); return true; } catch { return false; }
  }).toBe(true);
  return value;
}
describe("game mailbox", () => {
  it("isolates simultaneous profiles, matches responses, and removes completed requests", async () => {
    const a = await fixture("Alpha"), b = await fixture("Beta");
    const first = a.game.sendCommand("ping"), second = b.game.sendCommand("ping");
    const ar = await request(a.root), br = await request(b.root);
    expect(ar.session).not.toBe(br.session);
    fs.writeFileSync(path.join(a.root, "response.json.txt"), JSON.stringify({ protocol: 1, id: br.id, session: br.session, success: true, data: "wrong" }));
    fs.writeFileSync(path.join(b.root, "response.json.txt"), JSON.stringify({ protocol: 1, id: br.id, session: br.session, success: true, data: "Beta" }));
    expect(await second).toEqual({ success: true, data: "Beta" });
    fs.writeFileSync(path.join(a.root, "response.json.txt"), JSON.stringify({ protocol: 1, id: ar.id, session: ar.session, success: true, data: "Alpha" }));
    expect(await first).toEqual({ success: true, data: "Alpha" });
    expect(fs.existsSync(path.join(a.root, "request.json"))).toBe(false);
  });
  it("cancels commands on a game restart instead of replaying them", async () => {
    const { root, game, state } = await fixture("Alpha");
    const pending = game.sendCommand("killPlayer", { username: "Bob" });
    const rejection = expect(pending).rejects.toThrow("restarted");
    await request(root);
    fs.writeFileSync(path.join(root, "status.json.txt"), JSON.stringify({ ...state, session: "new-boot" }));
    await rejection;
    expect(fs.existsSync(path.join(root, "request.json"))).toBe(false);
  });
  it("waits for a fresh post-monitor heartbeat and rejects future dates", async () => {
    const { root, game, state } = await fixture("Alpha");
    const file = path.join(root, "status.json.txt");
    fs.utimesSync(file, new Date(Date.now() - 1000), new Date(Date.now() - 1000));
    game.start(root, "Alpha");
    expect(game.isConnected()).toBe(false);
    fs.writeFileSync(file, JSON.stringify(state));
    const stamp = new Date(Date.now() + 5); fs.utimesSync(file, stamp, stamp);
    await expect.poll(() => game.isConnected()).toBe(true);
    fs.utimesSync(file, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
    await expect.poll(() => game.isConnected()).toBe(false);
  });
  it("rejects invalid usernames and unsupported actions before writing requests", async () => {
    const { root, game } = await fixture("Alpha");
    await expect(game.sendCommand("killPlayer", { username: "bad\\name" })).rejects.toThrow("username");
    await expect(game.sendCommand("saveWorld")).rejects.toThrow("Unsupported");
    expect(fs.existsSync(path.join(root, "request.json"))).toBe(false);
  });
});
it("installs the bundled integration and removes only recognized legacy code", async () => {
  const { root } = await fixture("Alpha");
  const dir = path.join(root, "media/lua/server"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "PanelBridge.lua"), "user owned Lua");
  expect(installGameIntegration({ installPath: root }).success).toBe(false);
  expect(fs.readFileSync(path.join(dir, "PanelBridge.lua"), "utf8")).toBe("user owned Lua");
  fs.writeFileSync(path.join(dir, "PanelBridge.lua"), "local PanelBridge = {}\n");
  expect(installGameIntegration({ installPath: root }).success).toBe(true);
  expect(fs.existsSync(path.join(dir, "PanelBridge.lua"))).toBe(false);
  expect(getGameIntegrationInstallStatus({ installPath: root })).toMatchObject({ installed: true, needsUpdate: false });
  expect(installGameIntegration({ installPath: root })).toMatchObject({ success: true, updated: false });
});
