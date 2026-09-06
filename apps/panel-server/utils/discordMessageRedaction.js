
import { getServers, getSetting } from "../database/init.js";
import { readUiSecretFile } from "./uiSecretFile.ts";
import { readIniValues } from "./templateFiles.js";
import fs from "fs";
import path from "path";

const REDACTED_PLACEHOLDER = "[REDACTED]";

function readServerJoinPassword(server) {
  try {
    const serverName = server?.serverName;
    const configPath =
      server?.serverConfigPath ||
      (server?.zomboidDataPath ? path.join(server.zomboidDataPath, "Server") : null);
    if (
      !configPath ||
      !serverName ||
      typeof serverName !== "string" ||
      path.basename(serverName) !== serverName ||
      serverName.includes("..")
    ) {
      return null;
    }
    const iniPath = path.join(configPath, `${serverName}.ini`);
    if (!fs.existsSync(iniPath)) return null;
    const content = fs.readFileSync(iniPath, "utf8");
    const value = readIniValues(content, ["Password"]).Password;
    return value || null;
  } catch {
    return null;
  }
}

export async function collectKnownSecretValues() {
  const values = new Set();

  try {
    const servers = await getServers();
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

export function redactKnownSecrets(text, secretValues) {
  if (typeof text !== "string" || !text || !secretValues?.length) return text;
  let result = text;
  for (const secret of secretValues) {
    if (!secret) continue;
    let escaped;
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
