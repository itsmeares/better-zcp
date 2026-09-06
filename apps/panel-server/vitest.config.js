import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/vitest.perFileDataDir.setup.mjs"],
    testTimeout: 60000,
  },
});
