import { expect, it } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { createServer, updateServer, getServer, deleteServer, closeDatabase, getDatabaseFilePath } from "../database/init.ts";
it("keeps credentials out of SQLite through updates and restart, and removes the secret when a profile is deleted", async () => {
  const server=await createServer({serverName:'SecretTest',rconPassword:'first-password'});
  await updateServer(server.id,{name:'Renamed'});
  closeDatabase();
  expect((await getServer(server.id)).rconPassword).toBe('first-password');
  await updateServer(server.id,{rconPassword:'changed-password'});
  const raw=fs.readFileSync(getDatabaseFilePath());
  for (const password of ['first-password','changed-password']) expect(raw.includes(Buffer.from(password))).toBe(false);
  const secret=path.join(path.dirname(getDatabaseFilePath()),'server-secrets',server.id+'.secret');
  expect(fs.readFileSync(secret,'utf8')).toBe('changed-password');
  await deleteServer(server.id);
  expect(fs.existsSync(secret)).toBe(false);
});
