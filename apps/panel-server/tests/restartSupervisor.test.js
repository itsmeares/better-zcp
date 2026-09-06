import { describe, expect, it } from "vitest";
import { isLinuxPanelSupervisor } from "../utils/restartSupervisor.js";

describe("Linux panel supervisor detection", () => {
  it("recognizes the generated start.sh supervisor environment", () => {
    expect(
      isLinuxPanelSupervisor({
        platform: "linux",
        env: {
          PANEL_SUPERVISOR_V: "2",
          PANEL_PRESERVE_GAME_SERVERS: "1",
        },
      }),
    ).toBe(true);
  });

  it("does not self-respawn on Linux without the supervisor contract", () => {
    expect(
      isLinuxPanelSupervisor({
        platform: "linux",
        env: { PANEL_SUPERVISOR_V: "2" },
      }),
    ).toBe(false);
  });

  it("does not apply the Linux rule on other platforms", () => {
    expect(
      isLinuxPanelSupervisor({
        platform: "win32",
        env: {
          PANEL_SUPERVISOR_V: "2",
          PANEL_PRESERVE_GAME_SERVERS: "1",
        },
      }),
    ).toBe(false);
  });
});