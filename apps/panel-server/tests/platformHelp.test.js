import { describe, expect, it } from "vitest";
import {
  getPanelFolderPermissionGuidance,
  getRestartAssessment,
} from "../services/panelUpdateChecker.js";

describe("platform-specific updater guidance", () => {
  it("does not tell Linux operators to run as Administrator", () => {
    const message = getPanelFolderPermissionGuidance("linux", "EACCES");
    expect(message).toContain("service user");
    expect(message).not.toContain("Administrator");
    expect(message).not.toContain("Program Files");
  });

  it("keeps Windows remediation on Windows", () => {
    const message = getPanelFolderPermissionGuidance("win32", "EACCES");
    expect(message).toContain("Administrator");
  });

  it("marks an unprotected Linux service restart as destructive", () => {
    expect(
      getRestartAssessment({
        platform: "linux",
        packaged: true,
        environment: { INVOCATION_ID: "service-run" },
        launcherProtected: false,
      }),
    ).toMatchObject({ gameServers: "at-risk", requiresConfirmation: true });
  });

  it("marks the shipped Linux supervisor contract as preserving game servers", () => {
    expect(
      getRestartAssessment({
        platform: "linux",
        packaged: true,
        environment: {
          INVOCATION_ID: "service-run",
          PANEL_SUPERVISOR_V: "2",
          PANEL_PRESERVE_GAME_SERVERS: "1",
        },
        launcherProtected: true,
      }),
    ).toMatchObject({ gameServers: "preserved", requiresConfirmation: false });
  });

  it("derives supervisor protection from the supplied environment", () => {
    expect(
      getRestartAssessment({
        platform: "linux",
        packaged: true,
        environment: {
          INVOCATION_ID: "service-run",
          PANEL_SUPERVISOR_V: "2",
          PANEL_PRESERVE_GAME_SERVERS: "1",
        },
      }),
    ).toMatchObject({
      gameServers: "preserved",
      reason: "isolated-linux-supervisor",
    });
  });
});
