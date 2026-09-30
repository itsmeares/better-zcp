import { afterEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { stageUpdateBundle, applyUpdateBundle } from "../services/updateBundle.ts";
import { writePanelRestartRequest } from "../services/panelSupervisor.ts";

const metadata = { panelVersion: "2.0.1", buildSha: "new", apiContractVersion: 1 };
const old = { panelVersion: "2.0.0", buildSha: "old", apiContractVersion: 1 };
let root: string, supervisor: ChildProcess | undefined, gameChild: ChildProcess | undefined;
async function until(check: () => boolean, timeout = 15000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (check()) return; await delay(50); } throw new Error("Fixture did not reach the expected state."); }
function write(name: string, value: string) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; }
async function prepare(failHealth = false) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-supervisor-"));
  const binary = path.join(root, process.platform === "win32" ? "ZomboidControlPanel.exe" : "ZomboidControlPanel");
  fs.copyFileSync(process.execPath, binary); fs.chmodSync(binary, 0o755);
  write("data/panel.sqlite", "original-data"); write("data/jwt.secret", "original-key");
  write("client/dist/build-info.json", JSON.stringify(old)); write("client/dist/index.html", "old-client"); write("start.sh", "old-launcher");
  write("incoming/build-info.json", JSON.stringify(metadata)); write("incoming/index.html", failHealth ? "fail-health" : "new-client");
  fs.copyFileSync(binary, path.join(root, "incoming-binary"));
  const journal = stageUpdateBundle({ installDir: root, version: metadata.panelVersion, binaryPath: binary, stagedBinaryPath: path.join(root, "incoming-binary"), liveClientPath: path.join(root, "client/dist"), incomingClientPath: path.join(root, "incoming"), metadata, managedFiles: { "start.sh": write("incoming-start.sh", "new-launcher") } });
  const game = write("game.cjs", `setInterval(()=>{},1000);`);
  gameChild = spawn(process.execPath, [game], { cwd: root, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { gameChild!.once("spawn", resolve); gameChild!.once("error", reject); });
  write("game.pid", String(gameChild.pid));
  const panel = write("panel.cjs", `
const fs=require('fs'),http=require('http');
const metadata=JSON.parse(fs.readFileSync('client/dist/build-info.json'));
if(metadata.panelVersion==='2.0.1'){fs.writeFileSync('data/panel.sqlite','migrated-data');fs.writeFileSync('data/jwt.secret','migrated-key');}
const fail=fs.readFileSync('client/dist/index.html','utf8')==='fail-health';
fs.writeFileSync('panel.pid',String(process.pid));
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'ok',...metadata,buildSha:fail?'wrong':metadata.buildSha,instanceId:process.env.PANEL_INSTANCE_ID}));});
server.listen(0,'127.0.0.1',()=>fs.writeFileSync('port.txt',String(server.address().port)));
setInterval(()=>{if(fs.existsSync('request-exit')){fs.rmSync('request-exit');server.close(()=>process.exit(75));}},20);
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('message',message=>{if(message?.type==='panel:shutdown')server.close(()=>process.exit(0));});
`);
  // The real API pins the port. The fixture takes the same port on subsequent launches.
  fs.writeFileSync(panel, fs.readFileSync(panel, "utf8").replace("server.listen(0,", "server.listen(fs.existsSync('port.txt')?Number(fs.readFileSync('port.txt')):0,"));
  const moduleUrl = new URL("../services/panelSupervisor.ts", import.meta.url).href;
  const harness = write("supervisor.mjs", `import {runPanelSupervisor} from ${JSON.stringify(moduleUrl)};process.on('message',message=>{if(message?.type==='fixture:shutdown')process.emit('SIGTERM');});process.exitCode=await runPanelSupervisor({binary:${JSON.stringify(binary)},args:[${JSON.stringify(panel)}],dataDirectory:${JSON.stringify(path.join(root,"data"))},healthTimeout:process.platform==='win32'?5000:750});if(process.connected)process.disconnect();`);
  return { binary, journal, harness };
}
function launch(harness: string) { supervisor = spawn(process.execPath, ["--experimental-strip-types", harness], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] }); supervisor.stdout?.on("data", () => {}); supervisor.stderr?.on("data", () => {}); }
afterEach(async () => {
  if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) { const done = new Promise(r => supervisor!.once("close", r)); if (supervisor.connected) supervisor.send({ type: "fixture:shutdown" }); else supervisor.kill("SIGTERM"); await done; }
  if (gameChild && gameChild.exitCode === null && gameChild.signalCode === null) {
    const done = new Promise(resolve => gameChild!.once("close", resolve)); gameChild.kill("SIGKILL"); await done;
  }
  gameChild = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  supervisor = undefined;
});

describe("shared native supervisor with real child processes", () => {
  it.each([false, true])("applies an update or restores failed health, keeping the game alive: failHealth=%s", async failHealth => {
    const p = await prepare(failHealth); launch(p.harness);
    await until(() => fs.existsSync(path.join(root, "port.txt")) && fs.existsSync(path.join(root, "game.pid")));
    const port = Number(fs.readFileSync(path.join(root, "port.txt"))), game = Number(fs.readFileSync(path.join(root, "game.pid"))), previousPanel = fs.readFileSync(path.join(root, "panel.pid"), "utf8");
    writePanelRestartRequest(root, port, true); write("request-exit", "");
    await until(() => fs.existsSync(path.join(root, "panel-update-result.json")));
    const result = JSON.parse(fs.readFileSync(path.join(root, "panel-update-result.json"), "utf8"));
    expect(result.status).toBe(failHealth ? "failed" : "success");
    expect(() => process.kill(game, 0)).not.toThrow();
    await until(() => fs.readFileSync(path.join(root, "panel.pid"), "utf8") !== previousPanel);
    expect(fs.readFileSync(path.join(root, "data/panel.sqlite"), "utf8")).toBe(failHealth ? "original-data" : "migrated-data");
    expect(fs.readFileSync(path.join(root, "data/jwt.secret"), "utf8")).toBe(failHealth ? "original-key" : "migrated-key");
    expect(fs.readFileSync(path.join(root, "start.sh"), "utf8")).toBe(failHealth ? "old-launcher" : "new-launcher");
    expect(JSON.parse(fs.readFileSync(path.join(root, "client/dist/build-info.json"), "utf8"))).toEqual(failHealth ? old : metadata);
  }, 20000);
  it("recovers an interrupted update before starting the panel", async () => {
    const p = await prepare(); applyUpdateBundle(p.journal, path.join(root, "data")); write("data/panel.sqlite", "half-migrated-data");
    launch(p.harness); await until(() => fs.existsSync(path.join(root, "port.txt")));
    expect(fs.readFileSync(path.join(root, "data/panel.sqlite"), "utf8")).toBe("original-data");
    expect(JSON.parse(fs.readFileSync(path.join(root, "client/dist/build-info.json"), "utf8"))).toEqual(old);
  }, 20000);
});
