/**
 * Redact known secret values at the Discord publishing boundary.
 *
 * Exact-value matching avoids guessing which output looks sensitive. Keeping
 * the guard at the publishing boundary covers both success and failure paths,
 * plus future senders.
 */

import { getServers, getSetting } from "../database/init.js";
import { readUiSecretFile } from "./uiSecretFile.js";
import { readIniValues } from "./templateFiles.js";
import fs from "fs";
import path from "path";

const REDACTED_PLACEHOLDER = "[REDACTED]";

// Per-server join Password (server.ini's Password= line) read LIVE off disk
// at collection time, not from any cached/stored value — closes the corner
// where an operator edited the .ini directly and the panel never separately
// recorded that value anywhere else. Best-effort: any resolution failure
// (missing path, missing file, unreadable) just means one fewer value to
// redact, never an error surfaced to the caller.
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

/**
 * Every secret VALUE the panel currently holds, across every server
 * profile, not just the active one — an RCON command's response isn't
 * necessarily about the active server, and the whole point is not to guess.
 * Best-effort throughout: any single lookup failing (a deleted server
 * profile's secret file, a server.ini that moved) never aborts the rest.
 *
 * Returns a plain array of non-empty strings. Deliberately no minimum
 * length or "too common a word" exemption — see the module header. An
 * operator's own weak password choice (e.g. literally "admin") is still a
 * real secret, and this module's whole premise is that over-redacting a
 * published message is strictly safer than leaking one, even if the
 * output reads oddly for that one case.
 */
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

/**
 * Replaces every exact occurrence of any secret value with a fixed
 * placeholder. Matches both the secret's raw form and its JSON-string-
 * escaped form (a quote/backslash/newline inside a password would
 * otherwise survive JSON.stringify() as `\"`/`\\`/`\n` and no longer
 * byte-match the raw value) — this function is applied to the
 * ALREADY-SERIALIZED request body text, not a pre-serialization object, so
 * both forms can legitimately appear.
 *
 * MUST NOT be changed to log, throw with, or otherwise construct any
 * string containing a matched secret — this function is the one place in
 * the whole path guaranteed to be holding the plaintext value.
 */
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
