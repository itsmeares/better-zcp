import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./fileWriteQueue.ts";
import { getDataPaths } from "./paths.ts";

type UiSecretValue = string | null | undefined;

function secretFilePath(name: string): string {
  return path.join(getDataPaths().dataDir, `${name}.secret`);
}

export function readUiSecretFile(name: string): string | null {
  try {
    return fs.readFileSync(secretFilePath(name), "utf8").trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writeUiSecretFile(name: string, value: UiSecretValue): void {
  const filePath = secretFilePath(name);
  if (value == null || value === "") {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  writeFileAtomic(filePath, value, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort: Windows / network shares */
  }
}
