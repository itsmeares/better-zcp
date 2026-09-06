import fs from "fs";
import path from "path";
import { readIniValues, readSandboxValue } from "./templateFiles.js";

const INI_KEYS = [
  "MaxPlayers",
  "PVP",
  "Map",
  "Public",
  "PublicName",
  "PauseEmpty",
  "Faction",
  "PlayerSafehouse",
  "GlobalChat",
  "SleepAllowed",
  "SleepNeeded",
];

const SANDBOX_KEYS = [
  "Zombies",
  "DayLength",
  "XpMultiplier",
  "FoodLootNew",
  "WeaponLootNew",
  "OtherLootNew",
  "HoursForLootRespawn",
];

function getConfigPath(server) {
  if (server?.serverConfigPath) return server.serverConfigPath;
  return server?.zomboidDataPath
    ? path.join(server.zomboidDataPath, "Server")
    : null;
}

function readFileIfPresent(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

export function captureBackupSnapshot(server) {
  const serverName = server?.serverName || "server";
  const configPath = getConfigPath(server);
  const iniContent = configPath
    ? readFileIfPresent(path.join(configPath, `${serverName}.ini`))
    : null;
  const sandboxContent = configPath
    ? readFileIfPresent(path.join(configPath, `${serverName}_SandboxVars.lua`))
    : null;
  const sandbox = {};

  for (const key of SANDBOX_KEYS) {
    const value = sandboxContent
      ? readSandboxValue(sandboxContent, "settings", key)
      : undefined;
    if (value !== undefined) sandbox[key] = value;
  }

  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    server: {
      id: server?.id ?? null,
      name: serverName,
      provider: server?.provider ?? (server?.isRemote ? "remote-sftp" : "native"),
    },
    serverIni: iniContent ? readIniValues(iniContent, INI_KEYS) : {},
    sandboxVars: sandbox,
  };
}