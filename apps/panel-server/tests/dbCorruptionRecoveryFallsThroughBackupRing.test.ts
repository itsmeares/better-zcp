import { expect, it } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { closeDatabase, createDatabaseBackup, getDatabaseFilePath, getSetting, setSetting } from "../database/init.ts";
it("skips a damaged newest backup and restores the older valid one", async () => {
  await setSetting("darkMode", "older good");
  await createDatabaseBackup();
  closeDatabase();
  fs.writeFileSync(path.join(path.dirname(getDatabaseFilePath()),"backups","panel-9999-corrupt.sqlite"),"damaged backup");
  fs.writeFileSync(getDatabaseFilePath(),"damaged database");
  expect(await getSetting("darkMode")).toBe("older good");
});
it("refuses to replace a damaged database when no valid backup remains", async () => {
  closeDatabase();
  const file = getDatabaseFilePath();
  for (const name of fs.readdirSync(path.join(path.dirname(file),"backups"))) fs.unlinkSync(path.join(path.dirname(file),"backups",name));
  fs.writeFileSync(file,"damaged without backup");
  await expect(getSetting("darkMode")).rejects.toThrow();
  expect(fs.readFileSync(file,"utf8")).toBe("damaged without backup");
});
