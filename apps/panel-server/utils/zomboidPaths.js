// Shared utilities for resolving and probing Zomboid data folders.
//
// Extracted from routes/chunks.js so other path-dependent routes (backups,
// serverFiles, serverFinder) can reuse the same normalization + suggestion
// logic without duplicating env-var / tilde handling and platform probes.

import fs from 'fs';
import os from 'os';
import path from 'path';

// ─── Path normalisation ──────────────────────────────────────────────────

// Normalize a user-supplied path:
//   - trim whitespace
//   - strip surrounding single/double quotes (common copy-paste artefact)
//   - expand a leading "~" to the user's home dir
//   - expand $VAR / ${VAR} (POSIX) and %VAR% (Windows) environment refs
//   - convert empty string back to null
// Defensive only — does NOT validate filesystem state.
export function normalizeUserPath(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
    if (!s) return null;
  }
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    s = path.join(os.homedir(), s.slice(1));
  }
  s = s.replace(/%([^%]+)%/g, (m, name) => process.env[name] || m);
  s = s.replace(/\$\{([^}]+)\}/g, (m, name) => process.env[name] || m);
  s = s.replace(/\$([A-Z_][A-Z0-9_]*)/gi, (m, name) => process.env[name] || m);
  return s;
}

// ─── Candidate probing ───────────────────────────────────────────────────

function computeCandidateZomboidPaths() {
  const home = os.homedir() || '';
  const candidates = [];

  if (process.platform === 'win32') {
    // PZ on Windows stores saves under %USERPROFILE%\Zomboid (NOT inside AppData).
    if (home) candidates.push(path.join(home, 'Zomboid'));
    if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, 'Zomboid'));
    if (process.env.PUBLIC) candidates.push(path.join(process.env.PUBLIC, 'Zomboid'));
  } else {
    if (home) {
      candidates.push(path.join(home, 'Zomboid'));
      candidates.push(path.join(home, '.zomboid'));
      candidates.push(path.join(home, 'pzserver', 'Zomboid'));
    }
    candidates.push('/root/Zomboid');
    candidates.push('/opt/pzserver/Zomboid');
    candidates.push('/srv/pz/Zomboid');
  }

  const seen = new Set();
  const result = [];
  for (const raw of candidates) {
    const p = path.resolve(raw);
    if (seen.has(p)) continue;
    seen.add(p);
    let exists = false;
    let hasSaves = false;
    try {
      exists = fs.existsSync(p) && fs.statSync(p).isDirectory();
      if (exists) hasSaves = fs.existsSync(path.join(p, 'Saves', 'Multiplayer'));
    } catch { /* ignore */ }
    result.push({ path: p, exists, hasSaves });
  }
  return result;
}

// 30s cache — the candidate set is per-host and per-process; existsSync over
// ~6-9 paths every request is wasteful on slow shares.
let _cache = { ts: 0, value: null };
const CACHE_TTL_MS = 30_000;

export function getCandidateZomboidPaths() {
  const now = Date.now();
  if (_cache.value && (now - _cache.ts) < CACHE_TTL_MS) return _cache.value;
  const value = computeCandidateZomboidPaths();
  _cache = { ts: now, value };
  return value;
}

// Test/development hook to bust the cache (e.g. after the user creates a new
// Zomboid folder and we want fresh probes).
export function invalidateCandidatePathsCache() {
  _cache = { ts: 0, value: null };
}

// ─── Heuristics for "does this look like a Zomboid data folder?" ─────────

const SAVE_ARTIFACTS = [
  'map',                  // B42 layout / B41 region dir
  'map_sand.bin',
  'map_meta.bin',
  'players.db',
  'serverlog.txt',
  'SandboxVars.lua',
  'WorldDictionary.bin',
  'global_mod_data.bin',
  'reanimated.bin',
];

// Files that mean "this is a PZ server install folder, NOT a user data folder".
const SERVER_INSTALL_ARTIFACTS = [
  'ProjectZomboid64.exe',
  'ProjectZomboid32.exe',
  'ProjectZomboid64.json',
  'ProjectZomboid32.json',
  'projectzomboid-dedi-server.sh',
  'start-server.sh',
  'steam_appid.txt',
];

function looksLikeSaveDir(dir) {
  try {
    return SAVE_ARTIFACTS.some(f => fs.existsSync(path.join(dir, f)));
  } catch { return false; }
}

function looksLikeServerInstall(dir) {
  try {
    return SERVER_INSTALL_ARTIFACTS.some(f => fs.existsSync(path.join(dir, f)));
  } catch { return false; }
}

// Inspect a resolved path and return a structured verdict. Caller decides
// whether to accept or reject — this lets the route surface per-check
// diagnostics in the debug payload instead of just a generic "rejected".
//
// Returns:
//   {
//     ok: boolean,
//     reason?: 'install-folder' | 'no-zomboid-markers',
//     checks: { hasSavesDir, hasMultiplayerDir, isInsideSavesDir,
//               hasZomboidMarker, hasSaveArtifacts, looksLikeInstall },
//     parentSuggestion?: string,   // e.g. user pointed at .../Saves
//   }
export function inspectZomboidPath(normalized) {
  const lower = normalized.toLowerCase().replace(/\\/g, '/');
  const basename = path.basename(normalized);

  const checks = {
    hasSavesDir: fs.existsSync(path.join(normalized, 'Saves')),
    hasMultiplayerDir: fs.existsSync(path.join(normalized, 'Multiplayer')),
    isInsideSavesDir: /\/saves(\/|$)/.test(lower),
    hasZomboidMarker: lower.includes('zomboid') || lower.includes('projectzomboid'),
    hasSaveArtifacts: false,
    looksLikeInstall: looksLikeServerInstall(normalized),
  };

  checks.hasSaveArtifacts = looksLikeSaveDir(normalized);
  if (!checks.hasSaveArtifacts) {
    try {
      const entries = fs.readdirSync(normalized, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (looksLikeSaveDir(path.join(normalized, e.name))) {
          checks.hasSaveArtifacts = true;
          break;
        }
      }
    } catch { /* ignore */ }
  }

  // Server install folder → reject early with a specific message.
  if (checks.looksLikeInstall && !checks.hasSavesDir && !checks.hasMultiplayerDir) {
    return { ok: false, reason: 'install-folder', checks };
  }

  // User pointed at a "Saves" or "Multiplayer" folder — suggest the parent.
  let parentSuggestion = null;
  if (basename === 'Saves' || basename === 'Multiplayer') {
    const parent = path.dirname(normalized);
    if (parent && parent !== normalized) parentSuggestion = parent;
  }

  const accepted = checks.hasSavesDir || checks.hasMultiplayerDir ||
                   checks.isInsideSavesDir || checks.hasZomboidMarker ||
                   checks.hasSaveArtifacts;

  if (!accepted) {
    return { ok: false, reason: 'no-zomboid-markers', checks, parentSuggestion };
  }
  return { ok: true, checks, parentSuggestion };
}
