import { expect, it, vi } from "vite-plus/test";
import { createServer } from "../database/init.ts";
import { RconService } from "../services/rcon.ts";
it("keeps an in-flight command and an empty-password second profile on separate connections", async()=>{
  const a=await createServer({serverName:'A',rconPassword:'a-password'});
  const b=await createServer({serverName:'B',rconHost:'127.0.0.2',rconPort:27016});
  const first=new RconService(a.id); const second=new RconService(b.id);
  await first.loadConfig(); await second.loadConfig();
  let resolveCommand;
  const client={execute: vi.fn(()=>new Promise(resolve=>{resolveCommand=resolve})),disconnect:vi.fn()};
  first.client=client; first.connected=true;
  const pending=first.execute('save',{skipLog:true});
  await expect(first.reloadConfig(b.id)).rejects.toThrow('Cannot retarget');
  expect(client.disconnect).not.toHaveBeenCalled();
  expect(second.config).toMatchObject({host:'127.0.0.2',port:27016,password:''});
  resolveCommand('saved');
  expect(await pending).toMatchObject({success:true,response:'saved'});
  expect(first.serverId).toBe(a.id);
});
