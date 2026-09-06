import { beforeEach, describe, expect, it, vi } from "vitest";

const getSetting = vi.fn();
const setSetting = vi.fn();

vi.mock("../database/init.js", () => ({
  getSetting,
  setSetting,
}));

const { PanelUpdateChecker } = await import(
  "../services/panelUpdateChecker.js"
);

describe("PanelUpdateChecker pending-update reconciliation", () => {
  beforeEach(() => {
    getSetting.mockReset();
    setSetting.mockReset();
  });

  it("clears an older marker after a newer manual installation", async () => {
    getSetting.mockResolvedValue("1.2.4");
    const checker = new PanelUpdateChecker();
    checker.currentVersion = "1.2.6";

    await checker.reconcilePendingUpdate();

    expect(setSetting).toHaveBeenCalledWith("pendingPanelUpdate", null);
    expect(setSetting).toHaveBeenCalledWith(
      "stagedPanelUpdateVersion",
      null,
    );
    expect(checker.lastApplyResult).toBeNull();
  });

  it("still records an exact-version apply as successful", async () => {
    getSetting.mockResolvedValue("1.2.6");
    const checker = new PanelUpdateChecker();
    checker.currentVersion = "1.2.6";

    await checker.reconcilePendingUpdate();

    expect(checker.lastApplyResult).toMatchObject({
      status: "success",
      appliedVersion: "1.2.6",
    });
  });

  it("keeps reporting a real failed apply when the panel is still older", async () => {
    getSetting.mockResolvedValue("1.2.6");
    const checker = new PanelUpdateChecker();
    checker.currentVersion = "1.2.5";

    await checker.reconcilePendingUpdate();

    expect(checker.lastApplyResult).toMatchObject({
      status: "failed",
      pendingVersion: "1.2.6",
    });
    expect(setSetting).not.toHaveBeenCalled();
  });

  // 2026-09-04, god's approval of the rollback_failed value: rollbackRetryLikely
  // must be present and correct when likelyCause is rollback_failed, and
  // absent for every other cause (so a UI checking for it on an unrelated
  // failure sees undefined, not a stale/irrelevant boolean).
  it("wires rollbackRetryLikely:true into lastApplyResult for a retry-risk rollback_failed log", async () => {
    getSetting.mockResolvedValue("1.2.6");
    const checker = new PanelUpdateChecker();
    checker.currentVersion = "1.2.5";
    checker.readMostRecentApplyLog = () =>
      "Apply: rollback cleanup incomplete; pending marker remains, journal retained [rollback_failed]\n";
    checker.getStagedUpdate = () => null;

    await checker.reconcilePendingUpdate();

    expect(checker.lastApplyResult).toMatchObject({
      likelyCause: "rollback_failed",
      rollbackRetryLikely: true,
    });
  });

  it("wires rollbackRetryLikely:false into lastApplyResult for the cosmetic journal-only rollback_failed log", async () => {
    getSetting.mockResolvedValue("1.2.6");
    const checker = new PanelUpdateChecker();
    checker.currentVersion = "1.2.5";
    checker.readMostRecentApplyLog = () =>
      "Apply: rollback restored artifacts but could not remove journal [rollback_failed]\n";
    checker.getStagedUpdate = () => null;

    await checker.reconcilePendingUpdate();

    expect(checker.lastApplyResult).toMatchObject({
      likelyCause: "rollback_failed",
      rollbackRetryLikely: false,
    });
  });

  it("omits rollbackRetryLikely entirely for a non-rollback failure cause", async () => {
    getSetting.mockResolvedValue("1.2.6");
    const checker = new PanelUpdateChecker();
    checker.currentVersion = "1.2.5";
    checker.readMostRecentApplyLog = () =>
      "Apply: staged binary missing or quarantined [av_quarantine]\n";
    checker.getStagedUpdate = () => null;

    await checker.reconcilePendingUpdate();

    expect(checker.lastApplyResult.likelyCause).toBe("av_quarantine");
    expect(checker.lastApplyResult).not.toHaveProperty("rollbackRetryLikely");
  });
});