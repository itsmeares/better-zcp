import fs from "fs";
import path from "path";
import { sanitizeError } from "./sanitize.ts";
import { withFileLock, writeFileAtomic } from "./fileWriteQueue.ts";
import { setIniKeyLine } from "./iniKeyWrite.ts";

export async function applyUpnpToIni(
  serverConfigPath: string,
  serverName: string,
  useUpnp: boolean,
) {
  const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
  if (!fs.existsSync(iniPath)) {
    return { applied: false, reason: `Server config not found at ${iniPath}` };
  }
  try {
    await withFileLock(iniPath, async () => {
      let content = fs.readFileSync(iniPath, "utf-8").replace(/\r\n/g, "\n");
      content = setIniKeyLine(content, "UPnP", useUpnp ? "true" : "false");
      writeFileAtomic(iniPath, content, { encoding: "utf-8", mode: 0o600 });
    });
    return { applied: true };
  } catch (error: any) {
    return { applied: false, reason: sanitizeError(error.message) };
  }
}
