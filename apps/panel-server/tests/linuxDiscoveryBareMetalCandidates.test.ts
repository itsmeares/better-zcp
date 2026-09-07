import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


let tmpHome;

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

afterEach(() => {
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = undefined;
  vi.unstubAllEnvs();
});

function buildInstall(installDir) {
  fs.mkdirSync(path.join(installDir, "media", "lua"), { recursive: true });
  fs.mkdirSync(path.join(installDir, "steamapps"), { recursive: true });
  fs.writeFileSync(path.join(installDir, "ProjectZomboid64"), "binary");
  fs.writeFileSync(path.join(installDir, "start-server.sh"), "#!/bin/bash\n");
}

function buildData(dataDir, serverName = "servertest") {
  fs.mkdirSync(path.join(dataDir, "Server"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "Server", `${serverName}.ini`),
    "RCONPort=27015\n",
  );
  fs.mkdirSync(path.join(dataDir, "Saves"), { recursive: true });
}

describe("discoverMounts(): bare-metal Linux SteamCMD layouts", () => {
  it.skipIf(process.platform === "win32")(
    "finds a ~/pzserver install with data at PZ's own real default cachedir (~/Zomboid, NOT nested under the install)",
    async () => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-discovery-home-"));
      const installDir = path.join(tmpHome, "pzserver");
      const dataDir = path.join(tmpHome, "Zomboid");
      buildInstall(installDir);
      buildData(dataDir);

      const { discoverMounts } = await import("../services/mountDiscovery.ts");
      const mounts = discoverMounts();

      expect(mounts).toContainEqual(
        expect.objectContaining({
          installPath: installDir,
          dataPath: dataDir,
          source: "linux-bare-metal",
          serverNames: ["servertest"],
        }),
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "prefers a Zomboid folder nested under the install over the $HOME fallback, when both exist",
    async () => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-discovery-home-"));
      const installDir = path.join(tmpHome, "pzserver");
      const nestedData = path.join(installDir, "Zomboid");
      const homeData = path.join(tmpHome, "Zomboid");
      buildInstall(installDir);
      buildData(nestedData, "nested-server");
      buildData(homeData, "home-server");

      const { discoverMounts } = await import("../services/mountDiscovery.ts");
      const mounts = discoverMounts();
      const found = mounts.find((m) => m.installPath === installDir);

      expect(found.dataPath).toBe(nestedData);
      expect(found.serverNames).toEqual(["nested-server"]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not report a bare-metal candidate when nothing is there (no false positive on a clean host)",
    async () => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-discovery-home-"));
      const { discoverMounts } = await import("../services/mountDiscovery.ts");
      const mounts = discoverMounts();
      expect(mounts.some((m) => m.source === "linux-bare-metal")).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "recognizes the alternate real launcher-script name (projectzomboid-dedi-server.sh), not just start-server.sh",
    async () => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-discovery-home-"));
      const installDir = path.join(tmpHome, "pzserver");
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(
        path.join(installDir, "projectzomboid-dedi-server.sh"),
        "#!/bin/bash\n",
      );

      const { probeInstallPath } = await import("../services/mountDiscovery.ts");
      const result = probeInstallPath(installDir);
      expect(result.valid).toBe(true);
      expect(result.hasStartScript).toBe(true);
    },
  );
});
