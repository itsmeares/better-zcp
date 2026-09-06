
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getDataPaths } from "./paths.js";
import { readSecret } from "./secrets.js";
import { checkAndExitIfOwnershipBlocked } from "./firstRunOwnershipCheck.js";

export function getJwtSecretPath() {
  return path.join(getDataPaths().dataDir, "jwt.secret");
}

const MIN_JWT_SECRET_LENGTH = 32;

function writeSecretFile(secretPath, value) {
  try {
    fs.writeFileSync(secretPath, value, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    if (
      (err.code === "EACCES" || err.code === "EPERM") &&
      checkAndExitIfOwnershipBlocked([getDataPaths().dataDir, secretPath])
    ) {
      throw err;
    }
    throw err;
  }
  try {
    fs.chmodSync(secretPath, 0o600);
  } catch {
    /* best-effort: Windows / network shares */
  }
}

export async function loadOrCreateJwtSecret({ legacyValue } = {}) {
  const envSecret = readSecret("JWT_SECRET");
  if (envSecret) {
    if (envSecret.length < MIN_JWT_SECRET_LENGTH) {
      throw new Error(
        `JWT_SECRET (or JWT_SECRET_FILE) is only ${envSecret.length} characters. Refusing to ` +
          `sign sessions with a weak key -- use at least ${MIN_JWT_SECRET_LENGTH} random ` +
          "characters (e.g. `openssl rand -hex 32`), or unset it to let the panel generate " +
          "and manage a strong one automatically.",
      );
    }
    return { secret: envSecret, source: "env" };
  }

  const secretPath = getJwtSecretPath();

  if (fs.existsSync(secretPath)) {
    let raw;
    try {
      raw = fs.readFileSync(secretPath, "utf8");
    } catch (err) {
      throw new Error(
        `JWT secret file exists but could not be read (${secretPath}): ${err.message}. ` +
          "Refusing to start rather than silently issuing a new signing key, which " +
          "would log out every user with nothing in the log to explain why. Fix the " +
          "file's permissions, or delete it to force a fresh key (this signs everyone " +
          "out), then restart.",
      );
    }
    const secret = raw.trim();
    if (!secret) {
      throw new Error(
        `JWT secret file exists but is empty (${secretPath}). Refusing to start rather ` +
          "than silently issuing a new signing key, which would log out every user with " +
          "nothing in the log to explain why. Delete the file to force a fresh key (this " +
          "signs everyone out), then restart.",
      );
    }
    return { secret, source: "file" };
  }

  if (legacyValue) {
    writeSecretFile(secretPath, legacyValue);
    return { secret: legacyValue, source: "migrated" };
  }

  const generated = crypto.randomBytes(64).toString("hex");
  writeSecretFile(secretPath, generated);
  return { secret: generated, source: "generated" };
}

export function regenerateJwtSecretFile() {
  const secretPath = getJwtSecretPath();
  const secret = crypto.randomBytes(64).toString("hex");
  writeSecretFile(secretPath, secret);
  return { secret, path: secretPath };
}
