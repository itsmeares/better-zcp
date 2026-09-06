import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

// Real module (not mocked) — normalizeServerMemory/serverPathEnvFallback
// tests already establish this as safe: getDataPaths() only touches the
// repo's gitignored data/ dir, no external state.
const { getCircuitBreakerStatus, commitNow, getDb } = await import(
  "../database/init.js"
);

// Mirrors MAX_WRITE_RETRIES in database/init.js — not exported since we're
// told not to touch the circuit breaker's own logic, only expose its state.
const MAX_WRITE_RETRIES = 5;

async function forceWriteFailures(times, message = "ENOSPC: no space left on device") {
  const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
    throw new Error(message);
  });
  for (let i = 0; i < times; i++) {
    await commitNow();
  }
  spy.mockRestore();
}

describe("getCircuitBreakerStatus", () => {
  beforeEach(async () => {
    await getDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports closed with no error when writes are healthy", async () => {
    await commitNow();
    const status = getCircuitBreakerStatus();
    expect(status.open).toBe(false);
    expect(status.lastError).toBeNull();
    expect(status.cooldownEndsAt).toBeNull();
  });

  it("opens after MAX_WRITE_RETRIES failures and surfaces the tripping error", async () => {
    await forceWriteFailures(MAX_WRITE_RETRIES, "ENOSPC: no space left on device");

    const status = getCircuitBreakerStatus();
    expect(status.open).toBe(true);
    expect(status.lastError).toMatch(/ENOSPC/);
    expect(status.failCount).toBe(MAX_WRITE_RETRIES);
    expect(status.cooldownEndsAt).not.toBeNull();
  });

  it("clears the error/failCount on the next successful write, independent of the cooldown timer", async () => {
    await forceWriteFailures(MAX_WRITE_RETRIES, "disk full");
    expect(getCircuitBreakerStatus().open).toBe(true);

    // commitNow() always flushes immediately — flushWrites() itself doesn't
    // gate on the circuit breaker (only the debounced scheduleWrite() path
    // does), so a direct write can succeed and heal the error bookkeeping
    // before the real 60s cooldown elapses.
    await commitNow();

    const status = getCircuitBreakerStatus();
    expect(status.lastError).toBeNull();
    expect(status.failCount).toBe(0);
    // The cooldown window itself is untouched by the successful write.
    expect(status.open).toBe(true);
  });

  it("reports closed once the cooldown window has elapsed", async () => {
    await forceWriteFailures(MAX_WRITE_RETRIES, "disk full");
    const { cooldownEndsAt } = getCircuitBreakerStatus();
    expect(cooldownEndsAt).not.toBeNull();

    vi.spyOn(Date, "now").mockReturnValue(new Date(cooldownEndsAt).getTime() + 1);
    expect(getCircuitBreakerStatus().open).toBe(false);
  });
});
