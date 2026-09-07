import fs from "node:fs";
import path from "node:path";
import { getDataPaths } from "./paths.ts";

export interface UiSecretLogger {
  warn?: (message: string) => void;
}

type UiSecretValue = string | null | undefined;

function secretFilePath(name: string): string {
  return path.join(getDataPaths().dataDir, `${name}.secret`);
}

function normalizeUiSecret(value: unknown): string | null {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readUiSecretFile(
  name: string,
  log?: UiSecretLogger | null,
): string | null {
  const filePath = secretFilePath(name);
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value || null;
  } catch (error: unknown) {
    log?.warn?.(
      `Could not read ${filePath}: ${errorMessage(error)}. Treating "${name}" as ` +
        "not configured until it is re-entered in Settings.",
    );
    return null;
  }
}

export function writeUiSecretFile(name: string, value: UiSecretValue): void {
  const filePath = secretFilePath(name);
  if (value == null || value === "") {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already absent */
    }
    return;
  }
  fs.writeFileSync(filePath, value, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort: Windows / network shares */
  }
}

interface SecretFileTransaction {
  name: string;
  value: string | null;
  target: string;
  staged: string;
  backup: string;
  hadOriginal: boolean;
  backedUp: boolean;
  activated: boolean;
}

export function replaceUiSecretFiles(
  entries: Array<[string, UiSecretValue]>,
): void {
  const transactionId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const files: SecretFileTransaction[] = entries.map(([name, value]) => {
    const target = secretFilePath(name);
    return {
      name,
      value: normalizeUiSecret(value),
      target,
      staged: `${target}.tmp-${transactionId}`,
      backup: `${target}.bak-${transactionId}`,
      hadOriginal: fs.existsSync(target),
      backedUp: false,
      activated: false,
    };
  });

  try {
    for (const file of files) {
      if (file.value === null) continue;
      fs.writeFileSync(file.staged, file.value, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      if (fs.readFileSync(file.staged, "utf8").trim() !== file.value) {
        throw new Error(`staged verification failed for ${file.name}`);
      }
    }

    for (const file of files) {
      if (file.hadOriginal) {
        fs.renameSync(file.target, file.backup);
        file.backedUp = true;
      }
    }
    for (const file of files) {
      if (file.value !== null) {
        fs.renameSync(file.staged, file.target);
        file.activated = true;
      }
    }

    for (const file of files) {
      if (readUiSecretFile(file.name) !== file.value) {
        throw new Error(`live verification failed for ${file.name}`);
      }
      if (file.value !== null) {
        try {
          fs.chmodSync(file.target, 0o600);
        } catch {
          /* best-effort: Windows / network shares */
        }
      }
    }

    for (const file of files) {
      try {
        fs.unlinkSync(file.backup);
      } catch {
        /* no previous file */
      }
    }
  } catch (error: unknown) {
    const rollbackErrors: string[] = [];
    for (const file of files) {
      try {
        if ((file.activated || file.backedUp) && fs.existsSync(file.target)) {
          fs.unlinkSync(file.target);
        }
        if (file.backedUp && fs.existsSync(file.backup)) {
          fs.renameSync(file.backup, file.target);
        }
      } catch (rollbackError: unknown) {
        rollbackErrors.push(`${file.name}: ${errorMessage(rollbackError)}`);
      }
      try {
        if (fs.existsSync(file.staged)) fs.unlinkSync(file.staged);
      } catch {
        /* best-effort cleanup */
      }
    }
    const rollbackDetail = rollbackErrors.length
      ? `; rollback incomplete (${rollbackErrors.join(", ")})`
      : "";
    throw new Error(
      `UI secret transaction failed: ${errorMessage(error)}${rollbackDetail}`,
    );
  }
}

interface LoadUiSecretOptions {
  legacyValue?: string | null;
  clearLegacy?: () => Promise<unknown> | unknown;
  log?: UiSecretLogger | null;
}

export async function loadUiSecret(
  name: string,
  { legacyValue, clearLegacy, log }: LoadUiSecretOptions = {},
): Promise<string | null> {
  const fromFile = readUiSecretFile(name, log);
  if (fromFile) return fromFile;

  if (legacyValue) {
    try {
      writeUiSecretFile(name, legacyValue);
      if (clearLegacy) await clearLegacy();
      log?.warn?.(
        `Moved "${name}" out of db.json into its own file. Same value, safer location.`,
      );
    } catch (error: unknown) {
      log?.warn?.(
        `Could not move "${name}" out of db.json (${errorMessage(error)}); using ` +
          "it from db.json for now, will retry moving it on the next restart.",
      );
    }
    return legacyValue;
  }

  return null;
}
