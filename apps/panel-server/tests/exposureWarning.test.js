import { describe, expect, it, vi } from "vitest";
import { logExposureWarningIfNeeded } from "../index.js";


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
