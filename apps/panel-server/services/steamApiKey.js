import { getSetting } from "../database/init.js";
import { readSecret } from "../utils/secrets.js";

/**
 * Deployment credentials override the database so they are never persisted
 * when Docker or Kubernetes provides the Steam API key as a secret.
 */
export async function getSteamApiKey() {
  return readSecret("STEAM_API_KEY") || getSetting("steamApiKey");
}
