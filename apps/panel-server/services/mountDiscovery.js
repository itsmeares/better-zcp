import fs from "fs";
import os from "os";
import path from "path";

const INI_SUFFIX_BLOCKLIST = [
  "_SandboxVars.ini",
  "_spawnpoints.ini",
  "_spawnregions.ini",
];

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function classifyDir(dirPath) {
  if (!dirPath) return "missing";
  try {
    return fs.statSync(dirPath).isDirectory() ? "ok" : "not-a-directory";
  } catch (err) {
    return err && err.code === "ENOENT" ? "missing" : "inaccessible";
  }
}

function safeIsDir(dirPath) {
  return classifyDir(dirPath) === "ok";
}

function readServerNames(serverDir) {
  if (!safeIsDir(serverDir)) return [];
  return safeReaddir(serverDir)
    .filter(
      (f) =>
        f.endsWith(".ini") &&
        !INI_SUFFIX_BLOCKLIST.some((suffix) => f.endsWith(suffix)),
    )
    .map((f) => f.replace(/\.ini$/, ""));
}

export function probeInstallPath(installPath) {
  const dirState = classifyDir(installPath);
  if (dirState !== "ok") {
    return {
      valid: false,
      reason: dirState === "inaccessible" ? "permission-denied" : undefined,
      serverNames: [],
      hasStartScript: false,
      hasPanelBridge: false,
    };
  }

  const entries = safeReaddir(installPath);
  const hasZomboidBinary = entries.some((f) => f.startsWith("ProjectZomboid64"));
  const hasStartScript =
    fs.existsSync(path.join(installPath, "start-server.sh")) ||
    fs.existsSync(path.join(installPath, "projectzomboid-dedi-server.sh"));
  const hasMediaLua = safeIsDir(path.join(installPath, "media", "lua"));
  const hasSteamapps = safeIsDir(path.join(installPath, "steamapps"));

  return {
    valid: hasZomboidBinary || hasStartScript || hasMediaLua || hasSteamapps,
    serverNames: readServerNames(path.join(installPath, "Server")),
    hasStartScript,
    hasPanelBridge: fs.existsSync(
      path.join(installPath, "media", "lua", "server", "PanelBridge.lua"),
    ),
  };
}

export function probeDataPath(dataPath) {
  const dirState = classifyDir(dataPath);
  if (dirState !== "ok") {
    return {
      valid: false,
      reason: dirState === "inaccessible" ? "permission-denied" : undefined,
      path: dataPath || null,
      serverNames: [],
    };
  }

  const serverNames = readServerNames(path.join(dataPath, "Server"));
  const hasSaves = safeIsDir(path.join(dataPath, "Saves"));
  const hasLua = safeIsDir(path.join(dataPath, "Lua"));

  return {
    valid: hasSaves || hasLua || serverNames.length > 0,
    path: dataPath,
    serverNames,
  };
}

export function findDataPath(installPath) {
  if (!installPath) return null;
  const candidate = path.join(installPath, "Zomboid");
  return safeIsDir(candidate) ? candidate : null;
}

const COMMON_MOUNT_CANDIDATES = [
  { install: "/pz-server", data: "/zomboid", source: "common-mount" },
  {
    install: "/serverdata/serverfiles",
    data: "/serverdata/serverfiles/Zomboid",
    source: "ich777-mount",
  },
  { install: "/steam/pz", data: "/steam/pz/Zomboid", source: "steam-mount" },
];

function envCandidates() {
  return [
    {
      install: process.env.PZ_SERVER_PATH,
      data: process.env.PZ_SAVE_PATH,
      source: "environment",
    },
  ];
}

function bareMetalLinuxCandidates() {
  if (process.platform === "win32") return [];
  const home = os.homedir();
  const roots = [];
  if (home) roots.push(path.join(home, "pzserver"));
  roots.push("/opt/pzserver");
  roots.push("/srv/pz");
  return roots.map((install) => ({ install, source: "linux-bare-metal" }));
}

function allCandidates() {
  return [
    ...envCandidates(),
    ...COMMON_MOUNT_CANDIDATES,
    ...bareMetalLinuxCandidates(),
  ];
}

function resolveDataPathCandidate(candidate) {
  if (candidate.data) return candidate.data;
  const nested = findDataPath(candidate.install);
  if (nested) return nested;
  if (candidate.source === "linux-bare-metal") {
    const home = os.homedir();
    return home ? path.join(home, "Zomboid") : null;
  }
  return null;
}

export function discoverMounts() {
  const candidates = [];
  const seen = new Set();

  for (const candidate of allCandidates()) {
    if (!candidate.install || seen.has(candidate.install)) continue;
    seen.add(candidate.install);

    const installResult = probeInstallPath(candidate.install);
    if (!installResult.valid) continue;

    const dataPath = resolveDataPathCandidate(candidate);
    const dataResult = probeDataPath(dataPath);

    candidates.push({
      installPath: candidate.install,
      dataPath: dataResult.valid ? dataResult.path : dataPath || null,
      source: candidate.source,
      serverNames: dataResult.serverNames.length
        ? dataResult.serverNames
        : installResult.serverNames,
      hasStartScript: installResult.hasStartScript,
      hasPanelBridge: installResult.hasPanelBridge,
    });
  }

  return candidates;
}

export function discoverMountIssues() {
  const issues = [];
  const seen = new Set();

  for (const candidate of allCandidates()) {
    if (!candidate.install || seen.has(candidate.install)) continue;
    seen.add(candidate.install);

    const installResult = probeInstallPath(candidate.install);
    if (installResult.reason === "permission-denied") {
      issues.push({
        path: candidate.install,
        source: candidate.source,
        reason: "permission-denied",
      });
      continue;
    }
    if (!installResult.valid) continue;

    const dataPath = resolveDataPathCandidate(candidate);
    if (probeDataPath(dataPath).reason === "permission-denied") {
      issues.push({
        path: dataPath,
        source: candidate.source,
        reason: "permission-denied",
      });
    }
  }

  return issues;
}

function parseIni(content) {
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex > 0) {
      result[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
    }
  }
  return result;
}

function parsePort(value, fallback, max = 65535) {
  if (value === undefined || value === null || value.trim() === "") {
    return fallback;
  }
  if (!/^\d+$/.test(value.trim())) return null;
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1 && port <= max ? port : null;
}

export function readServerIniSettings(dataPath, serverName) {
  const iniPath = path.join(dataPath, "Server", `${serverName}.ini`);
  if (!fs.existsSync(iniPath)) return null;

  let settings;
  try {
    settings = parseIni(fs.readFileSync(iniPath, "utf-8"));
  } catch {
    return null;
  }

  const rconPort = parsePort(settings.RCONPort, 27015);
  const serverPort = parsePort(settings.DefaultPort, 16261, 65534);
  if (rconPort === null || serverPort === null) return null;

  return {
    rconPort,
    rconPassword: settings.RCONPassword || "",
    serverPort,
    publicName: settings.PublicName || serverName,
  };
}
