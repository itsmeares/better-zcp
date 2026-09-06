import { defineConfig } from "vitest/config";

// These tests spawn subprocesses and use real timers. A longer timeout avoids
// false failures on busy runners; individual tests can still set a lower limit.
export default defineConfig({
  test: {
    setupFiles: ["./tests/vitest.perFileDataDir.setup.mjs"],
    testTimeout: 60000,
  },
});
