import { getSetting } from "../database/init.js";
import { readSecret } from "../utils/secrets.ts";

export async function getSteamApiKey() {
  return readSecret("STEAM_API_KEY") || getSetting("steamApiKey");
}
