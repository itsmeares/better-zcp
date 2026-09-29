import { describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const bootstrap = new URL("../../../infra/docker/all-in-one/bootstrap.sh", import.meta.url).pathname;

describe("all-in-one host update", () => {
  it("leaves the existing install alone while Project Zomboid is running", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-docker-update-"));
    try {
      const bin = path.join(root, "bin");
      const release = path.join(root, "release", "better-zcp-2.0.0", "infra", "docker", "all-in-one");
      const state = path.join(root, "state");
      fs.mkdirSync(bin, { recursive: true });
      fs.mkdirSync(release, { recursive: true });
      fs.mkdirSync(path.join(state, "build", "source"), { recursive: true });
      fs.writeFileSync(path.join(state, "build", "source", "marker"), "original");
      fs.writeFileSync(path.join(release, "Dockerfile"), "FROM scratch\n");
      execFileSync("tar", ["-czf", path.join(root, "release.tar.gz"), "-C", path.join(root, "release"), "better-zcp-2.0.0"]);
      fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then cp '${root}/release.tar.gz' "$2"; exit; fi; shift; done\nexit 1\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh\ncase "$1 $2" in\n  'info ') exit 0;;\n  'info --format') echo amd64;;\n  'compose version') exit 0;;\n  'inspect --format') echo true;;\n  'inspect zomboid-panel') exit 0;;\n  'top zomboid-panel') echo 'steam 1 java zombie.network.GameServer';;\n  *) echo "unexpected docker call: $*" >&2; exit 99;;\nesac\n`, { mode: 0o755 });
      const result = spawnSync("sh", [bootstrap, "2.0.0"], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PANEL_HOME: state },
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Save and stop it from the panel before splitting the containers.");
      expect(fs.readFileSync(path.join(state, "build", "source", "marker"), "utf8")).toBe("original");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
