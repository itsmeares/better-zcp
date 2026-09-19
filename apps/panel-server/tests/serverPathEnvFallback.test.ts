import { afterEach, describe, expect, it } from "vitest";

const { normalizeServerMemory } = await import("../database/init.ts");

const ORIGINAL_SERVER_PATH = process.env.PZ_SERVER_PATH;
const ORIGINAL_SAVE_PATH = process.env.PZ_SAVE_PATH;

function restoreEnv() {
  if (ORIGINAL_SERVER_PATH === undefined) delete process.env.PZ_SERVER_PATH;
  else process.env.PZ_SERVER_PATH = ORIGINAL_SERVER_PATH;
  if (ORIGINAL_SAVE_PATH === undefined) delete process.env.PZ_SAVE_PATH;
  else process.env.PZ_SAVE_PATH = ORIGINAL_SAVE_PATH;
}

describe("normalizeServerMemory env-var fallback", () => {
  afterEach(restoreEnv);

  it("falls back to PZ_SERVER_PATH / PZ_SAVE_PATH when the db has empty paths", () => {
    process.env.PZ_SERVER_PATH = "/env/pz-server";
    process.env.PZ_SAVE_PATH = "/env/zomboid-data";

    const result = normalizeServerMemory({
      installPath: "",
      zomboidDataPath: null,
    });

    expect(result.installPath).toBe("/env/pz-server");
    expect(result.zomboidDataPath).toBe("/env/zomboid-data");
  });

  it("prefers the db value over the env var when both are set", () => {
    process.env.PZ_SERVER_PATH = "/env/pz-server";
    process.env.PZ_SAVE_PATH = "/env/zomboid-data";

    const result = normalizeServerMemory({
      installPath: "/db/pz-server",
      zomboidDataPath: "/db/zomboid-data",
    });

    expect(result.installPath).toBe("/db/pz-server");
    expect(result.zomboidDataPath).toBe("/db/zomboid-data");
  });
});
