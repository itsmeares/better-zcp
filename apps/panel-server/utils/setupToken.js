
import crypto from "crypto";
import { getSetting, setSetting } from "../database/init.js";
import { createLogger } from "./logger.js";

const log = createLogger("Setup");
const TOKEN_BYTES = 32;

export async function getOrCreateSetupToken() {
  const envToken = process.env.SETUP_TOKEN;
  if (envToken && envToken.trim()) {
    return envToken.trim();
  }

  let token = await getSetting("setupToken");
  if (!token) {
    token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
    await setSetting("setupToken", token);
    log.info("Generated a new per-install setup token");
  }
  return token;
}

export async function logSetupTokenIfNeeded(needsSetup, loggerInstance = log) {
  if (!needsSetup) return;
  const token = await getOrCreateSetupToken();
  loggerInstance.warn(
    `SETUP TOKEN required to complete first-run setup: ${token}\n` +
      "    Treat this like a password: anyone who has it can create the admin account. " +
      "Restart the panel to print it again if you lose it, or set SETUP_TOKEN yourself " +
      "before starting to choose your own value.",
  );
}

export async function verifySetupToken(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const expected = await getOrCreateSetupToken();
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function clearSetupToken() {
  await setSetting("setupToken", null);
}
