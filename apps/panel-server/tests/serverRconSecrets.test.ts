import { expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { withRconSecret, withoutRconSecret } from "../utils/serverRconSecrets.ts";
import { getDataPaths } from "../utils/paths.ts";
it("redacts a copy, keeps independent files and preserves an existing secret if a replacement fails", () => {
  const server={id:'one',rconPassword:'one-password',name:'One'};
  const data=withoutRconSecret(server);
  expect(data).toEqual({id:'one',name:'One'});
  expect(server.rconPassword).toBe('one-password');
  withoutRconSecret({id:'two',rconPassword:'two-password'});
  expect(withRconSecret(data).rconPassword).toBe('one-password');
  const original=fs.writeFileSync;
  const spy=vi.spyOn(fs,'writeFileSync').mockImplementation((file,...args)=>{
    if (String(file).includes('.one.secret.')) throw new Error('disk full');
    return original(file,...args);
  });
  try { expect(()=>withoutRconSecret({...server,rconPassword:'replacement'})).toThrow('disk full'); }
  finally { spy.mockRestore(); }
  expect(withRconSecret(data).rconPassword).toBe('one-password');
  expect(withRconSecret({id:'two'}).rconPassword).toBe('two-password');
  withoutRconSecret({...server,rconPassword:''});
  expect(fs.existsSync(path.join(getDataPaths().dataDir,'server-secrets','one.secret'))).toBe(false);
  expect(()=>withRconSecret({id:'../escape'})).toThrow('Invalid server ID');
});
