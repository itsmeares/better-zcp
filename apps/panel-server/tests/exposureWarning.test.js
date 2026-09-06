import { describe, expect, it, vi } from "vitest";
import { logExposureWarningIfNeeded } from "../index.js";

// Regression coverage for the startup exposure warning (apps/panel-server/index.js,
// called right after the "Ready" banner in start()). authService.middleware()
// deliberately leaves every /api/* route open while first-run setup is
// pending, or while authentication is explicitly disabled -- both are correct
// behavior for a LAN-only install, but become a real race/exposure risk the
// moment the panel is reachable from the internet. This can't be prevented in
// code (the panel has no way to know its own reachability), so the fix is to
// make it loud rather than silent at the one moment an operator would
// otherwise assume "it's running, so it's protected".
//
// The load-bearing case is the negative one: a normal, fully-set-up,
// auth-enabled panel must NOT warn on every restart -- a warning nobody ever
// needs to act on is one everyone learns to ignore.

function fakeLogger() {
  return { warn: vi.fn() };
}

describe("logExposureWarningIfNeeded", () => {
  it("warns when no admin account exists yet (needsSetup)", async () => {
    const loggerInstance = fakeLogger();

    await logExposureWarningIfNeeded({
      needsSetup: true,
      boundPort: 3001,
      localIp: "192.168.1.50",
      authServiceInstance: { isAuthEnabled: vi.fn(async () => true) },
      loggerInstance,
    });

    expect(loggerInstance.warn).toHaveBeenCalledTimes(1);
    expect(loggerInstance.warn.mock.calls[0][0]).toContain(
      "no admin account exists",
    );
    expect(loggerInstance.warn.mock.calls[0][0]).toContain(
      "192.168.1.50:3001",
    );
  });

  it("warns when authentication is explicitly disabled", async () => {
    const loggerInstance = fakeLogger();

    await logExposureWarningIfNeeded({
      needsSetup: false,
      boundPort: 3001,
      localIp: "127.0.0.1",
      authServiceInstance: { isAuthEnabled: vi.fn(async () => false) },
      loggerInstance,
    });

    expect(loggerInstance.warn).toHaveBeenCalledTimes(1);
    expect(loggerInstance.warn.mock.calls[0][0]).toContain(
      "authentication is disabled",
    );
  });

  it("does NOT warn for a normal, fully set up, auth-enabled panel -- the common case must stay quiet", async () => {
    const loggerInstance = fakeLogger();

    await logExposureWarningIfNeeded({
      needsSetup: false,
      boundPort: 3001,
      localIp: "192.168.1.50",
      authServiceInstance: { isAuthEnabled: vi.fn(async () => true) },
      loggerInstance,
    });

    expect(loggerInstance.warn).not.toHaveBeenCalled();
  });

  it("falls back to a placeholder host when bound only to loopback", async () => {
    const loggerInstance = fakeLogger();

    await logExposureWarningIfNeeded({
      needsSetup: true,
      boundPort: 3001,
      localIp: "127.0.0.1",
      authServiceInstance: { isAuthEnabled: vi.fn(async () => true) },
      loggerInstance,
    });

    expect(loggerInstance.warn.mock.calls[0][0]).toContain(
      "<this-machine>:3001",
    );
  });

  it("does not call isAuthEnabled at all when setup is still pending -- needsSetup already implies the answer", async () => {
    const isAuthEnabled = vi.fn(async () => true);
    const loggerInstance = fakeLogger();

    await logExposureWarningIfNeeded({
      needsSetup: true,
      boundPort: 3001,
      localIp: "127.0.0.1",
      authServiceInstance: { isAuthEnabled },
      loggerInstance,
    });

    expect(isAuthEnabled).not.toHaveBeenCalled();
  });
});
