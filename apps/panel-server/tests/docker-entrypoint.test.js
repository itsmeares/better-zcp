import { describe, expect, it } from "vitest";
import fs from "fs";

const entrypoint = fs.readFileSync(
  new URL("../../../infra/docker/all-in-one/entrypoint.sh", import.meta.url),
  "utf8",
);

describe("all-in-one Docker entrypoint", () => {
  it("gives every steam process an explicit writable home", () => {
    expect(entrypoint).toMatch(/^STEAM_HOME=\/home\/steam$/m);
    expect(entrypoint).toContain('chown -R ${STEAM_UID}:${STEAM_GID}');
    expect(entrypoint).toContain('"$STEAM_HOME"');

    const steamCommands = entrypoint.match(/^.*\bsu steam\b.*$/gm) ?? [];
    expect(steamCommands).toHaveLength(2);
    for (const command of steamCommands) {
      expect(command).toContain("export HOME='$STEAM_HOME'");
    }
  });
});
