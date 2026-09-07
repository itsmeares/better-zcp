import fs from "node:fs";
import path from "node:path";
import { readIniValues, readSandboxValue } from "./templateFiles.ts";

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

export interface BackupSnapshotServer {
  id?: string | number | null;
  serverName?: string;
  provider?: string | null;
  isRemote?: boolean;
  serverConfigPath?: string | null;
  zomboidDataPath?: string | null;
}

function getConfigPath(server: BackupSnapshotServer | null | undefined): string | null {
  if (server?.serverConfigPath) return server.serverConfigPath;
  return server?.zomboidDataPath
    ? path.join(server.zomboidDataPath, "Server")
    : null;
}

function readFileIfPresent(filePath: string): string | null {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

export function captureBackupSnapshot(
  server: BackupSnapshotServer | null | undefined,
) {
  const serverName = server?.serverName || "server";
  const configPath = getConfigPath(server);
  const iniContent = configPath
    ? readFileIfPresent(path.join(configPath, `${serverName}.ini`))
    : null;
  const sandboxContent = configPath
    ? readFileIfPresent(path.join(configPath, `${serverName}_SandboxVars.lua`))
    : null;
  const sandbox: Record<string, unknown> = {};

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
