import { describe, expect, it } from "vite-plus/test";
import { generateStartupScripts } from "../services/serverLaunch.ts";

describe("startup script input boundaries", () => {
  it.each(["serverName", "adminPassword", "zomboidDataPath", "installPath"])(
    "rejects control characters in %s instead of changing the value",
    (field) => {
      for (const value of [
        "safe\r\necho INJECTED",
        "safe\0value",
        "safe\tvalue",
        { toString: () => "unsafe" },
      ]) {
        expect(() =>
          generateStartupScripts({ serverName: "Fixture", [field]: value }),
        ).toThrow(/without control characters/);
      }
    },
  );
});
