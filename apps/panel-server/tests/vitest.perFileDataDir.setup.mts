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

afterAll(() => {
  delete process.env.PANEL_PATHS_CONFIG_PATH;
  delete process.env.PANEL_DATABASE_DRIVER;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
