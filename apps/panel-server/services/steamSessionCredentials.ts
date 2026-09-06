import { getSetting, setSetting } from "../database/init.js";
import { createLogger } from "../utils/logger.ts";
import {
  loadUiSecret,
  readUiSecretFile,
  replaceUiSecretFiles,
} from "../utils/uiSecretFile.ts";

const log = createLogger("SteamSessionCredentials");

export interface SteamSessionCredentials {
  sessionId: string | null;
  loginSecure: string | null;
}

export async function getSteamSessionCredentials(): Promise<SteamSessionCredentials> {
  const [legacySessionId, legacyLoginSecure] = await Promise.all([
    getSetting("steamSessionId"),
    getSetting("steamLoginSecure"),
  ]);
  const [sessionId, loginSecure] = await Promise.all([
    loadUiSecret("steamSessionId", {
      legacyValue: legacySessionId,
      clearLegacy: () => setSetting("steamSessionId", null),
      log,
    }),
    loadUiSecret("steamLoginSecure", {
      legacyValue: legacyLoginSecure,
      clearLegacy: () => setSetting("steamLoginSecure", null),
      log,
    }),
  ]);
  return {
    sessionId: (sessionId as string | null) ?? null,
    loginSecure: (loginSecure as string | null) ?? null,
  };
}

export async function setSteamSessionCredentials(
  sessionId?: string | null,
  loginSecure?: string | null,
): Promise<void> {
  const [legacySessionId, legacyLoginSecure] = await Promise.all([
    getSetting("steamSessionId"),
    getSetting("steamLoginSecure"),
  ]);
  const currentSessionId =
    readUiSecretFile("steamSessionId", log) ?? legacySessionId;
  const currentLoginSecure =
    readUiSecretFile("steamLoginSecure", log) ?? legacyLoginSecure;
  const nextSessionId =
    sessionId === undefined ? currentSessionId : sessionId;
  const nextLoginSecure =
    loginSecure === undefined ? currentLoginSecure : loginSecure;

  try {
    replaceUiSecretFiles([
      ["steamSessionId", nextSessionId],
      ["steamLoginSecure", nextLoginSecure],
    ]);
    const normalize = (value: unknown): string | null => {
      if (value == null || value === "") return null;
      return String(value).trim() || null;
    };
    if (
      readUiSecretFile("steamSessionId", log) !== normalize(nextSessionId) ||
      readUiSecretFile("steamLoginSecure", log) !== normalize(nextLoginSecure)
    ) {
      throw new Error("canonical read-back verification failed");
    }
    await Promise.all([
      setSetting("steamSessionId", null),
      setSetting("steamLoginSecure", null),
    ]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not persist Steam session credentials: ${message}`);
  }
}
