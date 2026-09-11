import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."));

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-test-"));
const configPath = path.join(tempRoot, "paths.config.json");
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      dataDir: path.join(tempRoot, "data"),
      logsDir: path.join(tempRoot, "logs"),
    },
    null,
    2,
  ),
  "utf8",
);
process.env.PANEL_PATHS_CONFIG_PATH = configPath;
// Most unit tests exercise the legacy JSON compatibility path so they can
// inspect redaction and recovery behavior. Production defaults to SQLite.
process.env.PANEL_DATABASE_DRIVER = "json";

async function removeTempRoot() {
  const retryableCodes = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
  const attempts = 20;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.promises.rm(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
      return;
    } catch (error: any) {
      if (!retryableCodes.has(error?.code) || attempt === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

afterAll(async () => {
  delete process.env.PANEL_PATHS_CONFIG_PATH;
  delete process.env.PANEL_DATABASE_DRIVER;
  await removeTempRoot();
});
