import { expect, it } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { createServer, logCommand, getDatabaseStats, getDatabaseFilePath, compactDatabase } from "../database/init.ts";
import { runForServer } from "../utils/serverScope.ts";
it("reports actual persisted counts and compacts expired performance rows", async()=>{
  const server=await createServer({serverName:'Stats'});
  const before=await getDatabaseStats();
  await runForServer(server.id,async()=>{for(let i=0;i<7;i++) await logCommand('command-'+i,'ok');});
  expect((await getDatabaseStats()).totalRecords).toBe(before.totalRecords+7);
  const fixture=new DatabaseSync(getDatabaseFilePath());
  fixture.prepare("INSERT INTO records(collection,server_id,id,data) VALUES('performance_history',?,'expired',?)").run(server.id, JSON.stringify({timestamp:'2000-01-01T00:00:00.000Z'}));
  fixture.close();
  const result=await compactDatabase();
  expect(result.removed).toBe(1);
  expect((await getDatabaseStats()).totalRecords).toBe(before.totalRecords+7);
});
