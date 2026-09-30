import { expect, it } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { getDatabaseFilePath, setSetting, createDatabaseBackup } from "../database/init.ts";
it.skipIf(process.platform === 'win32')("restricts the database and backup under a permissive umask", async () => {
  const previous = process.umask(0);
  try {
    await setSetting("darkMode",true);
    const backup = await createDatabaseBackup();
    for (const file of [getDatabaseFilePath(),path.join(path.dirname(getDatabaseFilePath()),'backups',backup.file)]) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  } finally { process.umask(previous); }
});
