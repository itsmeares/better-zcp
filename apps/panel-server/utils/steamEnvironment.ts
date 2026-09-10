import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDataPaths } from "./paths.ts";

function getSteamHomePath(basePath: string): string {
  const base = path.resolve(basePath);
  const label = path.basename(base).replace(/[^a-zA-Z0-9_-]/g, "_") || "instance";
  const digest = crypto.createHash("sha256").update(base, "utf8").digest("hex").slice(0, 16);
  const homeRoot = path.join(getDataPaths().dataDir, "steam-homes");
  return path.join(homeRoot, `${label}-${digest}`);
}

export function buildLinuxWritableHomeEnv(
  basePath: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const homePath = getSteamHomePath(basePath);
  try {
    fs.mkdirSync(homePath, { recursive: true, mode: 0o700 });
    fs.chmodSync(homePath, 0o700);
  } catch {
    // Keep the child env usable; the child process will report a real failure.
  }
  return { ...env, HOME: homePath };
}
