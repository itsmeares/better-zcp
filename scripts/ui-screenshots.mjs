#!/usr/bin/env node
// Captures every client route in demo mode, in dark and light, on desktop and
// phone. The images are review evidence for UI changes and are not committed.
//
// Usage: pnpm screenshots [label] [--routes=/,/console]
// Output: .screenshots/<label>/<route>-<theme>-<viewport>.png

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const ROUTES = [
  '/', '/console', '/players', '/world-map', '/server-config', '/mods',
  '/scheduler', '/backups', '/servers', '/server-setup', '/settings', '/debug',
];
// The theme key and its stored values are kept across the redesign, so the
// same script captures the old and the new UI.
const THEMES = { dark: 'survival', light: 'light' };
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};
const PORT = 5198;

const args = process.argv.slice(2);
const label = args.find((arg) => !arg.startsWith('--')) ?? new Date().toISOString().replace(/[:.]/g, '-');
const routesArg = args.find((arg) => arg.startsWith('--routes='));
const routes = routesArg ? routesArg.slice('--routes='.length).split(',') : ROUTES;
const outDir = path.resolve('.screenshots', label);

const server = spawn('pnpm', ['--filter', '@better-zcp/panel-client', 'exec', 'vp', 'dev', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  env: { ...process.env, VITE_DEMO_MODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already stopped */ } };
process.on('exit', stopServer);

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return;
    } catch { /* not up yet */ }
    await delay(300);
  }
  throw new Error(`Demo dev server did not start:\n${serverLog}`);
}

await waitForServer();
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const pageErrors = [];
try {
  for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
    for (const [themeName, stored] of Object.entries(THEMES)) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, ...viewport, reducedMotion: 'reduce' });
      await context.addInitScript((value) => localStorage.setItem('pz-panel-theme', value), stored);
      const page = await context.newPage();
      let current = '';
      page.on('pageerror', (error) => pageErrors.push(`${current}: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') pageErrors.push(`${current}: ${message.text()}`);
      });
      for (const route of routes) {
        current = `${route} (${themeName}, ${viewportName})`;
        await page.goto(`http://127.0.0.1:${PORT}/#${route}`, { waitUntil: 'networkidle' });
        await delay(600);
        const name = `${route === '/' ? 'overview' : route.slice(1).replace(/\//g, '_')}-${themeName}-${viewportName}.png`;
        await page.screenshot({ path: path.join(outDir, name), fullPage: true });
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  stopServer();
}
console.log(`Saved ${routes.length * 4} screenshots to ${path.relative(process.cwd(), outDir)}`);
if (pageErrors.length > 0) {
  console.log(`\n${pageErrors.length} page errors:`);
  for (const line of [...new Set(pageErrors)]) console.log(`  ${line}`);
}
