import { afterEach, describe, expect, it } from "vite-plus/test";
import { normalizeServerMemory } from "../database/init.ts";

const previousManaged = process.env.PANEL_MANAGED_GAMES;
afterEach(() => {
  if (previousManaged === undefined) delete process.env.PANEL_MANAGED_GAMES;
  else process.env.PANEL_MANAGED_GAMES = previousManaged;
});

describe("combined Docker profile compatibility", () => {
  it("maps each old shared-volume profile to its own game container without changing its stored data", () => {
    process.env.PANEL_MANAGED_GAMES = "true";
    const old = { id: "server-a", installPath: "/pz-server", zomboidDataPath: "/zomboid", rconHost: "127.0.0.1" };
    const next = normalizeServerMemory(old);
    expect(next).toMatchObject({ dockerContainerName: "zomboid-game-server-a", rconHost: "zomboid-game-server-a" });
    expect(old).toEqual({ id: "server-a", installPath: "/pz-server", zomboidDataPath: "/zomboid", rconHost: "127.0.0.1" });
  });

  it("keeps explicit external Docker mappings and other paths", () => {
    process.env.PANEL_MANAGED_GAMES = "true";
    expect(normalizeServerMemory({ id: "a", installPath: "/pz-server", zomboidDataPath: "/zomboid", dockerContainerName: "external-game", rconHost: "external-game" })?.dockerContainerName).toBe("external-game");
    expect(normalizeServerMemory({ id: "b", installPath: "/other-game", zomboidDataPath: "/zomboid" })?.dockerContainerName).toBeUndefined();
  });
});
