import fs from "node:fs";
import path from "node:path";
import { getServers, getSetting } from "../database/init.js";
import { readIniValues } from "./templateFiles.ts";
import { readUiSecretFile } from "./uiSecretFile.ts";

const REDACTED_PLACEHOLDER = "[REDACTED]";

interface ServerLike {
  serverName?: unknown;
  serverConfigPath?: unknown;
  zomboidDataPath?: unknown;
  rconPassword?: unknown;
}

function readServerJoinPassword(server: ServerLike | null | undefined): string | null {
  try {
    const serverName =
      typeof server?.serverName === "string" ? server.serverName : null;
    const configPath =
      typeof server?.serverConfigPath === "string"
        ? server.serverConfigPath
        : typeof server?.zomboidDataPath === "string"
          ? path.join(server.zomboidDataPath, "Server")
          : null;
    if (
      !configPath ||
      !serverName ||
      path.basename(serverName) !== serverName ||
      serverName.includes("..")
    ) {
      return null;
    }
    const iniPath = path.join(configPath, `${serverName}.ini`);
    if (!fs.existsSync(iniPath)) return null;
    const content = fs.readFileSync(iniPath, "utf8");
    const value = (readIniValues(content, ["Password"]) as { Password?: string })
      .Password;
    return value || null;
  } catch {
    return null;
  }
}

export async function collectKnownSecretValues(): Promise<string[]> {
  const values = new Set<string>();

  try {
    const servers = (await getServers()) as ServerLike[];
    for (const server of servers) {
      if (server?.rconPassword) values.add(String(server.rconPassword));
      const joinPassword = readServerJoinPassword(server);
      if (joinPassword) values.add(joinPassword);
    }
  } catch {
    /* best-effort: a database read failure here must not block sending */
  }

  try {
    const legacyRconPassword = await getSetting("rconPassword");
    if (legacyRconPassword) values.add(String(legacyRconPassword));
  } catch {
    /* best-effort */
  }

  for (const secretFileName of [
    "discordBotToken",
    "panelBridgeSftpPassword",
    "steamSessionId",
    "steamLoginSecure",
  ]) {
    try {
      const value = readUiSecretFile(secretFileName);
      if (value) values.add(value);
    } catch {
      /* best-effort */
    }
  }

  values.delete("");
  return [...values];
}

export function redactKnownSecrets(
  text: unknown,
  secretValues: readonly string[] | null | undefined,
): unknown {
  if (typeof text !== "string" || !text || !secretValues?.length) return text;
  let result = text;
  for (const secret of secretValues) {
    if (!secret) continue;
    let escaped: string | null;
    try {
      escaped = JSON.stringify(secret).slice(1, -1);
    } catch {
      escaped = null;
    }
    if (escaped && escaped !== secret) {
      result = result.split(escaped).join(REDACTED_PLACEHOLDER);
    }
    result = result.split(secret).join(REDACTED_PLACEHOLDER);
  }
  return result;
}
