import fs from "fs";
import os from "os";
import path from "path";

export interface CandidateZomboidPath {
  path: string;
  exists: boolean;
  hasSaves: boolean;
}

interface PathChecks {
  hasSavesDir: boolean;
  hasMultiplayerDir: boolean;
  isInsideSavesDir: boolean;
  hasZomboidMarker: boolean;
  hasSaveArtifacts: boolean;
  looksLikeInstall: boolean;
}

export interface ZomboidPathInspection {
  ok: boolean;
  reason?: "install-folder" | "no-zomboid-markers";
  checks: PathChecks;
  parentSuggestion?: string | null;
}

export function normalizeUserPath(input: unknown): string | null {
  if (input == null) return null;
  let value = String(input).trim();
  if (!value) return null;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
    if (!value) return null;
  }
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    value = path.join(os.homedir(), value.slice(1));
  }
  value = value.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] || match);
  value = value.replace(/\$\{([^}]+)\}/g, (match, name: string) => process.env[name] || match);
  value = value.replace(/\$([A-Z_][A-Z0-9_]*)/gi, (match, name: string) => process.env[name] || match);
  return value;
}

function computeCandidateZomboidPaths(): CandidateZomboidPath[] {
  const home = os.homedir() || "";
  const candidates: string[] = [];

  if (process.platform === "win32") {
    if (home) candidates.push(path.join(home, "Zomboid"));
    if (process.env.USERPROFILE) {
      candidates.push(path.join(process.env.USERPROFILE, "Zomboid"));
    }
    if (process.env.PUBLIC) {
      candidates.push(path.join(process.env.PUBLIC, "Zomboid"));
    }
  } else {
    if (home) {
      candidates.push(path.join(home, "Zomboid"));
      candidates.push(path.join(home, ".zomboid"));
      candidates.push(path.join(home, "pzserver", "Zomboid"));
    }
    candidates.push("/root/Zomboid");
    candidates.push("/opt/pzserver/Zomboid");
    candidates.push("/srv/pz/Zomboid");
  }

  const seen = new Set<string>();
  const result: CandidateZomboidPath[] = [];
  for (const raw of candidates) {
    const candidatePath = path.resolve(raw);
    if (seen.has(candidatePath)) continue;
    seen.add(candidatePath);
    let exists = false;
    let hasSaves = false;
    try {
      exists =
        fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory();
      if (exists) {
        hasSaves = fs.existsSync(
          path.join(candidatePath, "Saves", "Multiplayer"),
        );
      }
    } catch {
      // A candidate can disappear while the scan is running.
    }
    result.push({ path: candidatePath, exists, hasSaves });
  }
  return result;
}

let pathCache: { ts: number; value: CandidateZomboidPath[] | null } = {
  ts: 0,
  value: null,
};
const CACHE_TTL_MS = 30_000;

export function getCandidateZomboidPaths(): CandidateZomboidPath[] {
  const now = Date.now();
  if (pathCache.value && now - pathCache.ts < CACHE_TTL_MS) {
    return pathCache.value;
  }
  const value = computeCandidateZomboidPaths();
  pathCache = { ts: now, value };
  return value;
}

export function invalidateCandidatePathsCache(): void {
  pathCache = { ts: 0, value: null };
}

const SAVE_ARTIFACTS = [
  "map",
  "map_sand.bin",
  "map_meta.bin",
  "players.db",
  "serverlog.txt",
  "SandboxVars.lua",
  "WorldDictionary.bin",
  "global_mod_data.bin",
  "reanimated.bin",
];

const SERVER_INSTALL_ARTIFACTS = [
  "ProjectZomboid64.exe",
  "ProjectZomboid32.exe",
  "ProjectZomboid64.json",
  "ProjectZomboid32.json",
  "projectzomboid-dedi-server.sh",
  "start-server.sh",
  "steam_appid.txt",
];

function looksLikeSaveDir(dir: string): boolean {
  try {
    return SAVE_ARTIFACTS.some((file) => fs.existsSync(path.join(dir, file)));
  } catch {
    return false;
  }
}

function looksLikeServerInstall(dir: string): boolean {
  try {
    return SERVER_INSTALL_ARTIFACTS.some((file) =>
      fs.existsSync(path.join(dir, file)),
    );
  } catch {
    return false;
  }
}

export function inspectZomboidPath(normalized: string): ZomboidPathInspection {
  const lower = normalized.toLowerCase().replace(/\\/g, "/");
  const basename = path.basename(normalized);

  const checks: PathChecks = {
    hasSavesDir: fs.existsSync(path.join(normalized, "Saves")),
    hasMultiplayerDir: fs.existsSync(path.join(normalized, "Multiplayer")),
    isInsideSavesDir: /\/saves(\/|$)/.test(lower),
    hasZomboidMarker:
      lower.includes("zomboid") || lower.includes("projectzomboid"),
    hasSaveArtifacts: false,
    looksLikeInstall: looksLikeServerInstall(normalized),
  };

  checks.hasSaveArtifacts = looksLikeSaveDir(normalized);
  if (!checks.hasSaveArtifacts) {
    try {
      const entries = fs.readdirSync(normalized, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (looksLikeSaveDir(path.join(normalized, entry.name))) {
          checks.hasSaveArtifacts = true;
          break;
        }
      }
    } catch {
      // The path may be unreadable or disappear during inspection.
    }
  }

  if (
    checks.looksLikeInstall &&
    !checks.hasSavesDir &&
    !checks.hasMultiplayerDir
  ) {
    return { ok: false, reason: "install-folder", checks };
  }

  let parentSuggestion: string | null = null;
  if (basename === "Saves" || basename === "Multiplayer") {
    const parent = path.dirname(normalized);
    if (parent && parent !== normalized) parentSuggestion = parent;
  }

  const accepted =
    checks.hasSavesDir ||
    checks.hasMultiplayerDir ||
    checks.isInsideSavesDir ||
    checks.hasZomboidMarker ||
    checks.hasSaveArtifacts;

  if (!accepted) {
    return {
      ok: false,
      reason: "no-zomboid-markers",
      checks,
      parentSuggestion,
    };
  }
  return { ok: true, checks, parentSuggestion };
}
