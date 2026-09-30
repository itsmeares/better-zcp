import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vite-plus/test";
import { generateStartSh } from "../../../scripts/release/build.mjs";

describe.skipIf(process.platform !== "linux")("Linux service launcher", () => {
  it("executes the copied runner as the service main PID and forwards arguments", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-launcher-"));
    fs.writeFileSync(path.join(root, "start.sh"), generateStartSh(), { mode: 0o755 });
    fs.writeFileSync(path.join(root, "ZomboidControlPanel"), '#!/bin/sh\nprintf "%s\\n" "$$" "$@" > arguments\ntrap "exit 0" TERM\nwhile :; do sleep .1; done\n', { mode: 0o755 });
    const child = spawn("sh", [path.join(root, "start.sh"), "--sample-argument"], { cwd: root });
    try {
      for (let i = 0; i < 100 && !fs.existsSync(path.join(root, "arguments")); i++) await delay(20);
      expect(fs.readFileSync(path.join(root, "arguments"), "utf8").trim().split("\n")).toEqual([String(child.pid), "--panel-supervisor", "--sample-argument"]);
    } finally { const closed = new Promise(r => child.once("close", r)); child.kill("SIGTERM"); await closed; fs.rmSync(root, { recursive: true, force: true }); }
  });
});
