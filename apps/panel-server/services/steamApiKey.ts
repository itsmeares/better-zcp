import { getSetting } from "../database/init.ts";
import { readSecret } from "../utils/secrets.ts";

export async function getSteamApiKey(): Promise<unknown> {
  return readSecret("STEAM_API_KEY") || getSetting("steamApiKey");
}
