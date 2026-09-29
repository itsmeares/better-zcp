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
  delete process.env.PANEL_DOCKER_INSTALL_KIND;
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

  it("offers a host command for the deployment kind", () => {
    process.env.PANEL_DOCKER_INSTALL_KIND = "aio";
    expect(getDockerUpgradeInstruction("v2.0.1")).toContain("bootstrap.sh | sh -s -- 2.0.1");
    expect(getDockerUpgradeInstruction("v2.0.1-rc5")).toContain("/v2.0.1-rc5/infra/docker/all-in-one/bootstrap.sh");
    expect(getDockerUpgradeInstruction("v2.0.1; rm -rf /oops")).toBe("");
    const checker = new PanelUpdateChecker();
    checker.latestRelease = { tag: "v2.0.1-rc5", version: "2.0.1" } as typeof checker.latestRelease;
    const status = checker.getStatus();
    expect(status.updateMode).toBe("docker");
    expect(status.dockerInstallKind).toBe("aio");
    expect(status.updateCommand).toContain("/v2.0.1-rc5/infra/docker/all-in-one/bootstrap.sh");

    delete process.env.PANEL_DOCKER_INSTALL_KIND;
    expect(getDockerUpgradeInstruction("v2.0.1")).toBe(
      "docker compose pull panel && docker compose up -d --no-deps panel",
    );
  });
});
