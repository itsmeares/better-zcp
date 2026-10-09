import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { handlePanelUpdateDownload } from "../http/panelUpdateHandlers.ts";

const isContainerized = vi.fn(() => true);
vi.mock("../utils/dockerDetect.ts", () => ({
  isContainerized: (...args: unknown[]) => isContainerized(...args),
}));

const { PanelUpdateChecker, getDockerUpgradeInstruction } = await import(
  "../services/panelUpdateChecker.ts"
);

afterEach(() => {
  delete process.env.PANEL_MANAGED_GAMES;
  delete process.env.PANEL_IMAGE_TAG;
  isContainerized.mockReturnValue(true);
});

describe("Docker panel updates", () => {
  it("refuses a panel update request without touching the game server", async () => {
    const checker = new PanelUpdateChecker();
    checker.updateAvailable = true;
    checker.latestRelease = { version: "2.0.1" } as typeof checker.latestRelease;
    const serverManager = { getServerProcessDetails: vi.fn() };
    const rconService = { save: vi.fn(), quit: vi.fn() };
    const response = { status: vi.fn(), json: vi.fn() };
    response.status.mockReturnValue(response);

    await handlePanelUpdateDownload(
      {
        body: { confirm: true },
        app: { get: (name: string) => ({ panelUpdateChecker: checker, serverManager, rconService })[name] },
      } as never,
      response as never,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: "docker_manual_update" }));
    expect(serverManager.getServerProcessDetails).not.toHaveBeenCalled();
    expect(rconService.save).not.toHaveBeenCalled();
    expect(rconService.quit).not.toHaveBeenCalled();
  });

  it("offers one compose command for a floating image tag", () => {
    for (const imageTag of [undefined, "latest", "stable"]) {
      if (imageTag) process.env.PANEL_IMAGE_TAG = imageTag;
      else delete process.env.PANEL_IMAGE_TAG;
      expect(getDockerUpgradeInstruction("v3.0.1")).toBe("docker compose up -d --pull always --no-deps panel");
    }
    process.env.PANEL_MANAGED_GAMES = "true";
    const checker = new PanelUpdateChecker();
    checker.latestRelease = { tag: "v3.0.1", version: "3.0.1" } as typeof checker.latestRelease;
    const status = checker.getStatus();
    expect(status.updateMode).toBe("docker");
    expect(status.dockerManagedGames).toBe(true);
    expect(status.dockerImagePinned).toBe(false);
    expect(status.updateCommand).toBe("docker compose up -d --pull always --no-deps panel");
  });

  it("selects the new version when the compose file pins the image tag", () => {
    process.env.PANEL_IMAGE_TAG = "3.0.0-rc2";
    expect(getDockerUpgradeInstruction("v3.0.0-rc3")).toBe(
      "BETTER_ZCP_VERSION=3.0.0-rc3 docker compose up -d --pull always --no-deps panel",
    );
    expect(getDockerUpgradeInstruction("v3.0.1; rm -rf /oops")).toBe("");
    const checker = new PanelUpdateChecker();
    checker.latestRelease = { tag: "v3.0.0-rc3", version: "3.0.0-rc3" } as typeof checker.latestRelease;
    expect(checker.getStatus().dockerImagePinned).toBe(true);
  });
});
