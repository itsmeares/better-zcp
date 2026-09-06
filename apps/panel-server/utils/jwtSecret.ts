import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getDataPaths } from "./paths.js";
import { readSecret } from "./secrets.ts";
import { checkAndExitIfOwnershipBlocked } from "./firstRunOwnershipCheck.js";

export function getJwtSecretPath(): string {
  return path.join(getDataPaths().dataDir, "jwt.secret");
}

const MIN_JWT_SECRET_LENGTH = 32;

function writeSecretFile(secretPath: string, value: string): void {
  try {
    fs.writeFileSync(secretPath, value, { encoding: "utf8", mode: 0o600 });
  } catch (error: unknown) {
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    if (
      (code === "EACCES" || code === "EPERM") &&
      checkAndExitIfOwnershipBlocked([getDataPaths().dataDir, secretPath])
    ) {
      throw error;
    }
    throw error;
  }
  try {
    fs.chmodSync(secretPath, 0o600);
  } catch {
    /* best-effort: Windows / network shares */
  }
}

interface LoadJwtSecretOptions {
  legacyValue?: string | null;
}

type JwtSecretSource = "env" | "file" | "migrated" | "generated";

export async function loadOrCreateJwtSecret({
  legacyValue,
}: LoadJwtSecretOptions = {}): Promise<{
  secret: string;
  source: JwtSecretSource;
}> {
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
    let raw: string;
    try {
      raw = fs.readFileSync(secretPath, "utf8");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `JWT secret file exists but could not be read (${secretPath}): ${message}. ` +
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

export function regenerateJwtSecretFile(): { secret: string; path: string } {
  const secretPath = getJwtSecretPath();
  const secret = crypto.randomBytes(64).toString("hex");
  writeSecretFile(secretPath, secret);
  return { secret, path: secretPath };
}
