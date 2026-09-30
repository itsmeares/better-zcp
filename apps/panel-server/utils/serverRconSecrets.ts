import fs from "node:fs";
import path from "node:path";
import { getDataPaths } from "./paths.ts";
import { writeFileAtomic } from "./fileWriteQueue.ts";

type ServerSecretRecord = {
  id: string;
  rconPassword?: string;
  [key: string]: any;
};
function secretPath(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid server ID");
  return path.join(getDataPaths().dataDir, "server-secrets", `${id}.secret`);
}

export function withRconSecret<T extends ServerSecretRecord>(server: T): T {
  try {
    return {
      ...server,
      rconPassword: fs.readFileSync(secretPath(server.id), "utf8"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { ...server, rconPassword: "" };
  }
}

export function withoutRconSecret<T extends ServerSecretRecord>(
  server: T,
): Omit<T, "rconPassword"> {
  const { rconPassword, ...record } = server;
  if (rconPassword === undefined) return record;
  if (!rconPassword) {
    deleteServerSecret(server.id);
    return record;
  }
  const file = secretPath(server.id);
  try {
    if (fs.readFileSync(file, "utf8") === rconPassword) return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, rconPassword, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return record;
}

export function deleteServerSecret(id: string | number): void {
  try {
    fs.unlinkSync(secretPath(String(id)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
