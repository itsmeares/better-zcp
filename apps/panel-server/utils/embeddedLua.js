
import fs from 'fs';
import path from 'path';

let cached;

export function getEmbeddedPanelBridgeLua() {
  if (cached !== undefined) return cached;
  try {
    const b64 = typeof PANEL_BRIDGE_LUA_B64 !== 'undefined' ? PANEL_BRIDGE_LUA_B64 : '';
    cached = (b64 && b64.length > 0) ? Buffer.from(b64, 'base64').toString('utf8') : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function getEmbeddedPanelBridgeVersion() {
  const content = getEmbeddedPanelBridgeLua();
  if (!content) return null;
  const m = content.match(/VERSION\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

export function compareModVersions(a, b) {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const parse = (v) => String(v).split('.').map((n) => {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : -1;
  });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

function ensureReadableDirTree(dir) {
  if (fs.existsSync(dir)) return;
  const parent = path.dirname(dir);
  if (parent !== dir) ensureReadableDirTree(parent);
  fs.mkdirSync(dir);
  try {
    fs.chmodSync(dir, 0o755);
  } catch {
    /* best-effort: Windows / network shares */
  }
}

export function writeLuaAtomic(destPath, content) {
  const dir = path.dirname(destPath);
  ensureReadableDirTree(dir);
  const tmpPath = path.join(dir, `.PanelBridge.lua.tmp.${process.pid}`);
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'w', 0o644);
    fs.writeSync(fd, content, 0, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* best-effort; some FS/OSes reject */ }
    try { fs.fchmodSync(fd, 0o644); } catch { /* best-effort: Windows / network shares */ }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    try { if (fd != null) fs.closeSync(fd); } catch { /* ignore */ }
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}
