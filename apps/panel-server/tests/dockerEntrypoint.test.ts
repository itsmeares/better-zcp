import { describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const script = new URL("../../../docker/entrypoint.sh", import.meta.url).pathname;
const run = (env: Record<string, string>, ...command: string[]) =>
  spawnSync("sh", [script, ...command], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
const runsAsRoot = process.getuid?.() === 0;

describe("Docker entrypoint", () => {
  it("rejects a non-numeric PUID or PGID before doing anything", () => {
    const result = run({ PUID: "node" }, "echo", "started");
    expect(result.status).toBe(64);
    expect(result.stdout).not.toContain("started");
  });

  it.skipIf(runsAsRoot)("runs the command as the current user when it cannot drop privileges", () => {
    const result = run({}, "echo", "started");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("started");
    expect(result.stderr).toContain("Not running as root");
  });

  it.skipIf(runsAsRoot)("refuses managed games without a root start", () => {
    const result = run({ PANEL_MANAGED_GAMES: "true" }, "echo", "started");
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("started");
    expect(result.stderr).toContain("PANEL_MANAGED_GAMES needs a root start");
  });

  it("installs the game as the panel user and retries steamcmd before giving up", () => {
    const entrypoint = fs.readFileSync(script, "utf8");
    expect(entrypoint).toContain("until setpriv --reuid=\"$puid\" --regid=\"$pgid\" --clear-groups");
    expect(entrypoint).toContain("+app_update 380870 validate");
    expect(entrypoint).toContain('[ "$attempt" -ge 3 ]');
    expect(entrypoint).toMatch(/^\s*export HOME=\/home\/steam$/m);
  });
});
