import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    setupFiles: ["./tests/vitest.perFileDataDir.setup.mts"],
    testTimeout: 60000,
  },
});
