import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


let tmpHome;

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      homedir: () => tmpHome,
    },
    homedir: () => tmpHome,
  };
});

afterEach(() => {
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = undefined;
});

describe("getModDetailsFromWorkshop: Flatpak Steam workshop content root", () => {
  it.skipIf(process.platform === "win32")(
    "finds a mod downloaded only into the Flatpak Steam sandbox path, not just native Steam roots",
    async () => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-flatpak-home-"));
      const workshopId = "999999999";
      const modRoot = path.join(
        tmpHome,
        ".var",
        "app",
        "com.valvesoftware.Steam",
        ".local",
        "share",
        "Steam",
        "steamapps",
        "workshop",
        "content",
        "108600",
        workshopId,
        "mods",
        "FlatpakTestMod",
      );
      fs.mkdirSync(modRoot, { recursive: true });
      fs.writeFileSync(
        path.join(modRoot, "mod.info"),
        "name=Flatpak Test Mod\nid=FlatpakTestMod\n",
      );

      const { getModDetailsFromWorkshop } = await import("../routes/mods.js");
      const details = getModDetailsFromWorkshop(
        workshopId,
        "/nonexistent-server-install-path",
      );

      expect(details).toEqual([
        expect.objectContaining({
          id: "FlatpakTestMod",
          name: "Flatpak Test Mod",
        }),
      ]);
    },
  );
});
