import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { recreatePanelContainer } = require("../../../infra/docker/all-in-one/updater/containerLifecycle.cjs");

describe("Docker updater container recreation", () => {
  it("removes an existing panel container before Compose recreates it", async () => {
    const run = vi.fn().mockResolvedValue("");

    await recreatePanelContainer("zomboid-panel", ["up", "-d", "panel"], run);

    expect(run.mock.calls).toEqual([
      ["docker", ["inspect", "zomboid-panel"]],
      ["docker", ["stop", "-t", "60", "zomboid-panel"]],
      ["docker", ["rm", "zomboid-panel"]],
      ["docker", ["compose", "up", "-d", "panel"]],
    ]);
  });

  it("runs Compose directly when the panel container is absent", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("No such object: zomboid-panel"))
      .mockResolvedValue("");

    await recreatePanelContainer("zomboid-panel", ["up", "-d", "panel"], run);

    expect(run.mock.calls).toEqual([
      ["docker", ["inspect", "zomboid-panel"]],
      ["docker", ["compose", "up", "-d", "panel"]],
    ]);
  });

  it("packages the lifecycle helper in the updater image", () => {
    const dockerfile = readFileSync(
      new URL("../../../infra/docker/all-in-one/updater/Dockerfile", import.meta.url),
      "utf8",
    );

    expect(dockerfile).toContain(
      "COPY infra/docker/all-in-one/updater/containerLifecycle.cjs ./containerLifecycle.cjs",
    );
  });
});
