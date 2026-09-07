import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/vitest.perFileDataDir.setup.mts"],
    testTimeout: 60000,
  },
});
