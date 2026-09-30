import { describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDatabaseBackup, setSetting, closeDatabase, getSetting, getDatabaseFilePath } from "../database/init.ts";
const directory = () => path.join(path.dirname(getDatabaseFilePath()), "backups");
function marker(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='darkMode' AND server_id=''").get().value); }
  finally { db.close(); }
}
it("snapshots the latest committed change and retains the newest five valid backups", async () => {
  for (let i=0;i<8;i++) {
    await setSetting("darkMode", i);
    const backup = await createDatabaseBackup();
    expect(marker(path.join(directory(),backup.file))).toBe(i);
    // Ensure chronological timestamps when the filesystem is faster than the clock.
    await new Promise(resolve => setTimeout(resolve,2));
  }
  expect(fs.readdirSync(directory()).map(name=>marker(path.join(directory(),name))).sort()).toEqual([3,4,5,6,7]);
});
it("recovers from the newest valid backup and preserves the damaged database", async () => {
  await setSetting("darkMode", "recovered");
  await createDatabaseBackup();
  closeDatabase();
  fs.writeFileSync(getDatabaseFilePath(), "damaged sqlite");
  await expect(getSetting("darkMode")).resolves.toBe("recovered");
  const damaged = fs.readdirSync(path.dirname(getDatabaseFilePath())).find(name=>name.startsWith('panel.sqlite.corrupt-'));
  expect(fs.readFileSync(path.join(path.dirname(getDatabaseFilePath()),damaged),'utf8')).toBe('damaged sqlite');
});
