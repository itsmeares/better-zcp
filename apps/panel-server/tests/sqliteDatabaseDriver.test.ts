import { describe, expect, it } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getDataPaths } from "../utils/paths.ts";
import { setSetting, getDatabaseFilePath, closeDatabase } from "../database/init.ts";

it("commits rows immediately and reads them in a new process", async () => {
  await setSetting("darkMode", "persisted");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    const { getSetting, closeDatabase } = await import(${JSON.stringify(new URL('../database/init.ts',import.meta.url).href)});
    console.log(await getSetting("darkMode")); closeDatabase();
  `], { env: process.env, encoding: "utf8", timeout: 15000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("persisted");
});

it("starts a fresh panel without modifying old panel files", async () => {
  closeDatabase();
  const { dataDir } = getDataPaths();
  fs.writeFileSync(path.join(dataDir,"db.json"), "old-json");
  fs.writeFileSync(path.join(dataDir,"db.sqlite"), "old-sqlite");
  await setSetting("darkMode", true);
  expect(fs.readFileSync(path.join(dataDir,"db.json"),"utf8")).toBe("old-json");
  expect(fs.readFileSync(path.join(dataDir,"db.sqlite"),"utf8")).toBe("old-sqlite");
  expect(path.basename(getDatabaseFilePath())).toBe("panel.sqlite");
});
