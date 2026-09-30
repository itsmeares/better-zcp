import { expect, it } from "vite-plus/test";
import { createServer } from "../database/init.ts";
import { runForServer } from "../utils/serverScope.ts";
import { addBackupRecord, listBackupRecords, removeBackupRecord } from "../services/backupRecords.ts";
it("keeps concurrent archive records and snapshots on their own profile", async () => {
  const servers=await Promise.all(['One','Two'].map(serverName=>createServer({serverName})));
  const added=await Promise.all(servers.map(server=>runForServer(server.id,()=>addBackupRecord({server,backup:{name:'same.zip',created:'2026-08-10T00:00:00.000Z',size:42},snapshot:{serverIni:{PVP:'false'}}}))));
  for (let i=0;i<servers.length;i++) await runForServer(servers[i].id,async()=>expect(await listBackupRecords()).toEqual([added[i]]));
  await runForServer(servers[0].id,async()=>{await removeBackupRecord('same.zip'); expect(await listBackupRecords()).toEqual([]);});
  await runForServer(servers[1].id,async()=>expect(await listBackupRecords()).toEqual([added[1]]));
});
