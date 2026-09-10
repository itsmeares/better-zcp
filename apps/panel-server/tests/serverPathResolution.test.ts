import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveZomboidPaths } from "../routes/server.ts";

describe("resolveZomboidPaths", () => {
  it("keeps the default Zomboid data folder beside the install when a trailing separator is supplied", () => {
    const installPath = path.join(path.parse(process.cwd()).root, "servers", "MyServer");
    const withoutSeparator = resolveZomboidPaths(installPath, null);
    const withSeparator = resolveZomboidPaths(`${installPath}${path.sep}`, null);

    expect(withSeparator.zomboidPath).toBe(withoutSeparator.zomboidPath);
    expect(withSeparator.zomboidPath).toBe(
      path.join(path.dirname(installPath), "MyServer_Data"),
    );
  });

  it("preserves an explicit data path", () => {
    const explicit = path.join(path.parse(process.cwd()).root, "custom-data");
    expect(resolveZomboidPaths("/ignored/install/", explicit).zomboidPath).toBe(explicit);
  });
});
