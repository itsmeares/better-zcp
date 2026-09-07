import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { generateStartSh } from "../../../scripts/release/build.mjs";

const roots = [];
const gameGroups = [];

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

afterEach(() => {
  for (const pid of gameGroups.splice(0)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const describeLinux = process.platform === "linux" ? describe : describe.skip;

describeLinux("Linux panel supervisor", () => {
  it("stops the panel while leaving a detached game-server group alive", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-supervisor-"));
    roots.push(root);
    const launcher = path.join(root, "start.sh");
    const panel = path.join(root, "ZomboidControlPanel");
    fs.writeFileSync(launcher, generateStartSh(), { mode: 0o755 });
    fs.writeFileSync(panel, `#!/bin/sh
setsid sh -c 'trap "" TERM INT; echo $$ > game.pid; while :; do sleep 1; done' &
echo $$ > panel.pid
trap 'exit 0' TERM INT
while :; do sleep 1; done
`, { mode: 0o755 });

    const supervisor = spawn("bash", [launcher], { cwd: root, stdio: "ignore" });
    await waitForFile(path.join(root, "game.pid"));
    const gamePid = Number(fs.readFileSync(path.join(root, "game.pid"), "utf8").trim());
    gameGroups.push(gamePid);

    supervisor.kill("SIGTERM");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("supervisor did not stop")), 5000);
      supervisor.once("close", () => { clearTimeout(timer); resolve(); });
    });

    expect(() => process.kill(gamePid, 0)).not.toThrow();
  }, 10_000);
});
