import { describe, expect, it } from "vitest";
import { isServerObservedRunning } from "../utils/serverStatus.js";

describe("isServerObservedRunning", () => {
  it("reports stopped when every signal is absent", () => {
    expect(isServerObservedRunning()).toBe(false);
  });

  it("accepts each direct running signal", () => {
    expect(isServerObservedRunning({ processRunning: true })).toBe(true);
    expect(isServerObservedRunning({ rconConnected: true })).toBe(true);
    expect(isServerObservedRunning({ bridgeConnected: true })).toBe(true);
  });

  it("keeps a systemd-hosted server online when strict process attribution fails", () => {
    expect(
      isServerObservedRunning({
        processRunning: false,
        rconConnected: true,
        bridgeConnected: true,
      }),
    ).toBe(true);
  });

  it("preserves an unknown state when process detection fails without another live signal", () => {
    expect(
      isServerObservedRunning({
        processRunning: false,
        processScanFailed: true,
      }),
    ).toBeNull();
  });

  it("trusts a completed host check over stale connector flags", () => {
    expect(
      isServerObservedRunning({
        processRunning: false,
        rconConnected: true,
        bridgeConnected: true,
        hostStateAuthoritative: true,
      }),
    ).toBe(false);
  });
});
