#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { stageUpdateBundle } from '../apps/panel-server/services/updateBundle.ts';

const release = path.resolve('release');
const metadata = JSON.parse(fs.readFileSync(path.join(release, 'client/dist/build-info.json')));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcp update (fixture) & test-'));
const binaryName = process.platform === 'win32' ? 'ZomboidControlPanel.exe' : 'ZomboidControlPanel';
const binary = path.join(root, binaryName), runner = path.join(root, `.panel-runner-smoke${process.platform === 'win32' ? '.exe' : ''}`);
const dataDirectory = path.join(root, 'data');
let supervisor, output = '';
async function until(check, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; if (process.platform !== 'win32' && supervisor?.exitCode !== null && supervisor?.exitCode !== undefined) throw new Error(`Supervisor exited: ${output}`); await delay(100); }
  throw new Error(`Packaged updater timed out: ${output}`);
}
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
try {
  fs.mkdirSync(dataDirectory); fs.cpSync(path.join(release, 'client'), path.join(root, 'client'), { recursive: true });
  fs.copyFileSync(path.join(release, binaryName), binary); fs.copyFileSync(binary, runner); if (process.platform !== 'win32') { fs.chmodSync(binary, 0o755); fs.chmodSync(runner, 0o755); }
  const pathsConfig = path.join(root, 'paths.json'); fs.writeFileSync(pathsConfig, JSON.stringify({ dataDir: dataDirectory, logsDir: path.join(root, 'logs') }));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  supervisor = spawn(process.platform === 'win32' ? binary : runner, process.platform === 'win32' ? [] : ['--panel-supervisor'], { cwd: root, env: { ...process.env, PANEL_PATHS_CONFIG_PATH: pathsConfig, PZ_SAVE_PATH: path.join(root, 'zomboid'), PORT: String(port), AUTO_OPEN_BROWSER: 'false', SETUP_TOKEN: 'packaged-update-fixture-token' }, stdio: ['ignore', 'pipe', 'pipe'] });
  supervisor.stdout.on('data', chunk => output = (output + chunk).slice(-32000)); supervisor.stderr.on('data', chunk => output = (output + chunk).slice(-32000));
  await until(async () => { try { return (await fetch(base+'/api/health')).ok; } catch { return false; } });
  const response = await fetch(base+'/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'updateadmin', password: 'PackagedUpdateFixture!42', rememberMe: true, panelPort: port, setupToken: 'packaged-update-fixture-token' }) });
  const auth = await response.json(); assert.equal(response.ok, true, JSON.stringify(auth));
  const headers = { Authorization: `Bearer ${auth.accessToken || auth.token}`, 'Content-Type': 'application/json' };
  const originalSecret = fs.readFileSync(path.join(dataDirectory, 'jwt.secret'), 'utf8');
  for (const failHealth of [false, true]) {
    const before = await fetch(base+'/api/health').then(r => r.json());
    const incoming = path.join(root, 'incoming'); fs.rmSync(incoming, { recursive: true, force: true }); fs.cpSync(path.join(release, 'client/dist'), incoming, { recursive: true });
    const expected = failHealth ? { ...metadata, buildSha: 'deliberately-wrong-build' } : metadata;
    fs.writeFileSync(path.join(incoming, 'build-info.json'), JSON.stringify(expected));
    const stagedBinary = path.join(root, 'incoming-binary'); fs.copyFileSync(path.join(release, binaryName), stagedBinary);
    stageUpdateBundle({ installDir: root, version: expected.panelVersion, binaryPath: binary, stagedBinaryPath: stagedBinary, liveClientPath: path.join(root, 'client/dist'), incomingClientPath: incoming, metadata: expected });
    const resultFile = path.join(root, 'panel-update-result.json'); const previousResult = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : '';
    const install = await fetch(base+'/api/panel/update', { method: 'POST', headers, body: '{}' }); assert.equal(install.ok, true, await install.text());
    if (failHealth) {
      await until(async () => { try { const health = await fetch(base+'/api/health').then(r => r.json()); return health.instanceId !== before.instanceId; } catch { return false; } });
      // Simulate data written by a new version in this temporary installation.
      const db = new DatabaseSync(path.join(dataDirectory, 'panel.sqlite')); db.prepare("INSERT INTO settings(server_id,key,value) VALUES ('','updaterFixture',?)").run(JSON.stringify('new-version-only')); db.close();
      fs.writeFileSync(path.join(dataDirectory, 'jwt.secret'), 'new-version-only-key');
    }
    await until(() => fs.existsSync(resultFile) && fs.readFileSync(resultFile, 'utf8') !== previousResult);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); assert.equal(result.status, failHealth ? 'failed' : 'success');
    await until(async () => { try { const health = await fetch(base+'/api/health').then(r => r.json()); return health.instanceId !== before.instanceId && health.buildSha === metadata.buildSha; } catch { return false; } });
    assert.equal(fs.readFileSync(path.join(dataDirectory, 'jwt.secret'), 'utf8'), originalSecret);
    const db = new DatabaseSync(path.join(dataDirectory, 'panel.sqlite')); assert.equal(db.prepare("SELECT value FROM settings WHERE key='updaterFixture'").get(), undefined); db.close();
    assert.equal((await fetch(base+'/api/panel/update-status', { headers })).ok, true, 'Existing session must survive update and rollback');
    console.log(`${process.platform} packaged update ${failHealth ? 'health failure + data rollback' : 'success'} passed`);
  }
} finally {
  if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) { const closed = new Promise(resolve => supervisor.once('close', resolve)); supervisor.kill('SIGTERM'); await closed; }
  if (process.platform === 'win32') {
    for (const lock of [path.join(dataDirectory, 'panel.lock'), path.join(root, '.panel-supervisor.lock')]) {
      if (!fs.existsSync(lock)) continue;
      try { process.kill(Number(fs.readFileSync(lock)), 'SIGKILL'); } catch { /* only this temporary installation's processes */ }
    }
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
