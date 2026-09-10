import fs from "fs";
import path from "path";

export function buildLinuxWritableHomeEnv(
  basePath: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const homePath = path.join(path.resolve(basePath), ".steamhome");
  try {
    fs.mkdirSync(homePath, { recursive: true, mode: 0o700 });
    fs.chmodSync(homePath, 0o700);
  } catch {
    // Keep the child env usable; the child process will report a real failure.
  }
  return { ...env, HOME: homePath };
}
