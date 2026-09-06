import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const initUrl = new URL("../database/init.js", import.meta.url).href;
const tempRoots = [];

function createSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-sqlite-driver-"));
  tempRoots.push(root);
  const configPath = path.join(root, "paths.config.json");
  const dataDir = path.join(root, "data");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ dataDir, logsDir: path.join(root, "logs") }),
  );
  return { root, configPath, dataDir };
}

function runChild(configPath, markerPath, source) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../.."),
      env: {
        ...process.env,
        PANEL_PATHS_CONFIG_PATH: configPath,
        PANEL_DATABASE_DRIVER: "sqlite",
        ZCP_INIT_URL: initUrl,
        ZCP_MARKER: markerPath,
      },
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 15000,
    },
  );
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("opt-in SQLite database driver", () => {
  it("persists the existing snapshot shape across processes", () => {
    const { configPath, dataDir, root } = createSandbox();
    const markerPath = path.join(root, "writer.marker");
    const writer = runChild(
      configPath,
      markerPath,
      `import fs from "node:fs";
const { getDb, commitNow } = await import(process.env.ZCP_INIT_URL);
const db = await getDb();
db.data.settings.sqliteDriverProbe = "ok";
await commitNow();
fs.writeFileSync(process.env.ZCP_MARKER, "written");
process.exit(0);`,
    );
    expect(writer.status, writer.stderr).toBe(0);

    const markerForReader = path.join(root, "reader.marker");
    const reader = runChild(
      configPath,
      markerForReader,
      `import fs from "node:fs";
const { getDb } = await import(process.env.ZCP_INIT_URL);
const db = await getDb();
fs.writeFileSync(process.env.ZCP_MARKER, db.data.settings.sqliteDriverProbe);
process.exit(0);`,
    );
    expect(reader.status, reader.stderr).toBe(0);
    expect(fs.readFileSync(markerForReader, "utf8")).toBe("ok");
    expect(fs.statSync(path.join(dataDir, "db.sqlite")).mode & 0o777).toBe(0o600);
  });

  it("refuses to silently replace a legacy database before import", () => {
    const { configPath, dataDir, root } = createSandbox();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "db.json"), "{}");
    const markerPath = path.join(root, "guard.marker");
    const result = runChild(
      configPath,
      markerPath,
      `import fs from "node:fs";
const { getDb } = await import(process.env.ZCP_INIT_URL);
try {
  await getDb();
  fs.writeFileSync(process.env.ZCP_MARKER, "unexpected-success");
  process.exit(1);
} catch (error) {
  fs.writeFileSync(process.env.ZCP_MARKER, error.message);
  process.exit(0);
}`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(markerPath, "utf8")).toMatch(
      /Run the explicit legacy importer/,
    );
  });
});
