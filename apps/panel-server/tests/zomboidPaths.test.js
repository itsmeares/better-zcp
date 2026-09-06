import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  normalizeUserPath,
  getCandidateZomboidPaths,
  invalidateCandidatePathsCache,
  inspectZomboidPath,
} from '../utils/zomboidPaths.js';

describe('normalizeUserPath', () => {
  it('returns null for null/undefined/empty input', () => {
    expect(normalizeUserPath(null)).toBe(null);
    expect(normalizeUserPath(undefined)).toBe(null);
    expect(normalizeUserPath('')).toBe(null);
    expect(normalizeUserPath('   ')).toBe(null);
  });

  it('trims whitespace', () => {
    expect(normalizeUserPath('  /tmp/foo  ')).toBe('/tmp/foo');
  });

  it('strips matching surrounding double quotes', () => {
    expect(normalizeUserPath('"/tmp/foo"')).toBe('/tmp/foo');
  });

  it('strips matching surrounding single quotes', () => {
    expect(normalizeUserPath("'/tmp/foo'")).toBe('/tmp/foo');
  });

  it('does not strip mismatched quotes', () => {
    expect(normalizeUserPath('"/tmp/foo')).toBe('"/tmp/foo');
    expect(normalizeUserPath('/tmp/foo"')).toBe('/tmp/foo"');
  });

  it('expands leading ~ to homedir', () => {
    const home = os.homedir();
    expect(normalizeUserPath('~/Zomboid')).toBe(path.join(home, 'Zomboid'));
    expect(normalizeUserPath('~')).toBe(home);
  });

  it('does not expand ~ in the middle of a path', () => {
    expect(normalizeUserPath('/tmp/~/foo')).toBe('/tmp/~/foo');
  });

  it('expands %VAR% style env refs (Windows)', () => {
    vi.stubEnv('PZ_TEST_VAR', '/tmp/zomboid-test');
    expect(normalizeUserPath('%PZ_TEST_VAR%/Saves')).toBe('/tmp/zomboid-test/Saves');
    vi.unstubAllEnvs();
  });

  it('expands ${VAR} and $VAR (POSIX)', () => {
    vi.stubEnv('PZ_TEST_VAR', '/srv/pz');
    expect(normalizeUserPath('${PZ_TEST_VAR}/data')).toBe('/srv/pz/data');
    expect(normalizeUserPath('$PZ_TEST_VAR/data')).toBe('/srv/pz/data');
    vi.unstubAllEnvs();
  });

  it('leaves unknown env refs as-is', () => {
    expect(normalizeUserPath('%DEFINITELY_NOT_SET_123%/foo')).toBe('%DEFINITELY_NOT_SET_123%/foo');
  });
});

describe('getCandidateZomboidPaths', () => {
  beforeEach(() => {
    invalidateCandidatePathsCache();
  });

  it('returns a non-empty array on any platform', () => {
    const candidates = getCandidateZomboidPaths();
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('returns objects with path/exists/hasSaves keys', () => {
    const [first] = getCandidateZomboidPaths();
    expect(first).toHaveProperty('path');
    expect(first).toHaveProperty('exists');
    expect(first).toHaveProperty('hasSaves');
    expect(typeof first.path).toBe('string');
    expect(typeof first.exists).toBe('boolean');
    expect(typeof first.hasSaves).toBe('boolean');
  });

  it('includes a homedir-relative Zomboid path', () => {
    const candidates = getCandidateZomboidPaths();
    const home = path.resolve(path.join(os.homedir(), 'Zomboid'));
    expect(candidates.some(c => c.path === home)).toBe(true);
  });

  it('deduplicates identical resolved paths', () => {
    const candidates = getCandidateZomboidPaths();
    const seen = new Set();
    for (const c of candidates) {
      expect(seen.has(c.path)).toBe(false);
      seen.add(c.path);
    }
  });

  it('caches results between calls', () => {
    const a = getCandidateZomboidPaths();
    const b = getCandidateZomboidPaths();
    // Same reference = cached
    expect(a).toBe(b);
  });

  it('invalidateCandidatePathsCache forces a fresh probe', () => {
    const a = getCandidateZomboidPaths();
    invalidateCandidatePathsCache();
    const b = getCandidateZomboidPaths();
    // Different reference = fresh
    expect(a).not.toBe(b);
    // But same content shape
    expect(a.map(c => c.path)).toEqual(b.map(c => c.path));
  });
});

describe('inspectZomboidPath', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-inspect-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('accepts a folder containing Saves/', () => {
    const dir = path.join(tmpRoot, 'arbitrary');
    fs.mkdirSync(path.join(dir, 'Saves'), { recursive: true });
    const v = inspectZomboidPath(dir);
    expect(v.ok).toBe(true);
    expect(v.checks.hasSavesDir).toBe(true);
  });

  it('accepts a folder containing Multiplayer/', () => {
    const dir = path.join(tmpRoot, 'arbitrary');
    fs.mkdirSync(path.join(dir, 'Multiplayer'), { recursive: true });
    const v = inspectZomboidPath(dir);
    expect(v.ok).toBe(true);
  });

  it('accepts a folder named Zomboid (case-insensitive name marker)', () => {
    const dir = path.join(tmpRoot, 'Zomboid');
    fs.mkdirSync(dir);
    const v = inspectZomboidPath(dir);
    expect(v.ok).toBe(true);
    expect(v.checks.hasZomboidMarker).toBe(true);
  });

  it('accepts a folder containing a PZ save-artifact file', () => {
    const dir = path.join(tmpRoot, 'unmarkedSave');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'map_sand.bin'), '');
    const v = inspectZomboidPath(dir);
    expect(v.ok).toBe(true);
    expect(v.checks.hasSaveArtifacts).toBe(true);
  });

  it('rejects a server install folder (ProjectZomboid64.exe present)', () => {
    const dir = path.join(tmpRoot, 'server');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'ProjectZomboid64.exe'), '');
    const v = inspectZomboidPath(dir);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('install-folder');
  });

  it('rejects unrelated empty folder', () => {
    const dir = path.join(tmpRoot, 'random');
    fs.mkdirSync(dir);
    const v = inspectZomboidPath(dir);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('no-zomboid-markers');
  });

  it('suggests parent when user points at a Saves folder', () => {
    const parent = path.join(tmpRoot, 'somewhere');
    const saves = path.join(parent, 'Saves');
    fs.mkdirSync(saves, { recursive: true });
    const v = inspectZomboidPath(saves);
    // /saves/ matches isInsideSavesDir so the path is technically accepted,
    // but parentSuggestion is still populated so the UI can offer "did you
    // mean the parent?" as a one-click alternative.
    expect(v.parentSuggestion).toBe(parent);
  });

  it('suggests parent when user points at a Multiplayer folder', () => {
    const parent = path.join(tmpRoot, 'somewhere', 'Saves');
    const mp = path.join(parent, 'Multiplayer');
    fs.mkdirSync(mp, { recursive: true });
    const v = inspectZomboidPath(mp);
    expect(v.parentSuggestion).toBe(parent);
  });
});
