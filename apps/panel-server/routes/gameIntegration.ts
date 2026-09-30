import { Router, type Request, type Response } from "../http/apiRouter.ts";
import { getPanelRuntime } from "../utils/panelRuntime.ts";
import { getCurrentServer, getSetting, setSetting, logPlayerAction } from "../database/init.ts";
import { getGameIntegrationInstallStatus, installGameIntegration } from "../services/gameIntegrationInstaller.ts";
import { persistSandboxOption } from "../services/sandboxPersistence.ts";
import { sanitizeError } from "../utils/sanitize.ts";
import type { GameIntegration } from "../services/gameIntegration.ts";

const router = Router();
const metadata = new WeakMap<GameIntegration, { session: string; data: any }>();
const game = (): GameIntegration => getPanelRuntime().gameIntegration;
function snapshot() {
  const integration = game();
  if (!integration.isConnected() || !integration.snapshot) throw Object.assign(new Error("Game integration is not connected. Start the server with the integration installed."), { status: 503 });
  return integration.snapshot;
}
function route(handler: (req: Request, res: Response) => Promise<unknown> | unknown) {
  return async (req: Request, res: Response) => {
    try { await handler(req, res); }
    catch (error: any) { res.status(error.status || 500).json({ success: false, error: sanitizeError(error.message || String(error)), ...(error.data ? { data: error.data } : {}) }); }
  };
}
async function sandboxOptions() {
  const integration = game();
  const state = snapshot();
  const cached = metadata.get(integration);
  if (cached?.session === state.session) return cached.data;
  const result = await integration.sendCommand("getAllSandboxOptions");
  metadata.set(integration, { session: state.session, data: result.data });
  return result.data;
}

router.get("/status", route(async (_req, res) => {
  const server = await getCurrentServer();
  const localInstall = getGameIntegrationInstallStatus(server);
  const state = game().getStatus();
  res.json({ ...state, localInstall: { ...localInstall, restartRequired: localInstall.needsUpdate || (localInstall.installed && (!state.modConnected || state.modStatus?.version !== localInstall.version)) } });
}));
router.post("/install", route(async (_req, res) => {
  const result = installGameIntegration(await getCurrentServer());
  if (!result.success) return res.status(400).json(result);
  res.json({ success: true, data: { ...result, restartRequired: true }, message: "Game integration installed. Start or restart the server to load it." });
}));
router.get("/server-info", route((_req, res) => {
  const state = snapshot();
  const data = { ...state } as Record<string, any>;
  delete data.session;
  delete data.protocol;
  res.json({ success: true, data: { ...data, players: state.playerDetails, map: state.world?.map } });
}));
router.get("/world/stats", route((_req, res) => res.json({ success: true, data: snapshot().world })));
router.get("/players", route((_req, res) => res.json({ success: true, data: { players: snapshot().playerDetails } })));
router.get("/players/:username", route((req, res) => {
  const player = snapshot().playerDetails.find((entry) => entry.username === req.params.username);
  if (!player) return res.status(404).json({ success: false, error: "Player is not online." });
  res.json({ success: true, data: player });
}));
for (const [path, action] of [["heal", "healPlayer"], ["kill", "killPlayer"]]) {
  router.post(`/players/:username/${path}`, route(async (req, res) => {
    const username = String(req.params.username);
    const args = { username };
    const result = await game().sendCommand(action, args);
    await logPlayerAction(username, path, null);
    res.json(result);
  }));
}
router.get("/sandbox/options", route(async (_req, res) => {
  const result = await game().sendCommand("getAllSandboxOptions");
  metadata.set(game(), { session: snapshot().session, data: result.data });
  res.json({ success: true, data: result.data });
}));
router.get("/sandbox", route(async (_req, res) => {
  const result = await game().sendCommand("getAllSandboxOptions");
  metadata.set(game(), { session: snapshot().session, data: result.data });
  const options = Object.values(result.data.options).flat() as any[];
  res.json({ success: true, values: Object.fromEntries(options.map((option) => [option.name, option.value])) });
}));
router.put("/sandbox/options/:name", route(async (req, res) => {
  const name = String(req.params.name);
  const data = await sandboxOptions();
  const option = (Object.values(data.options).flat() as any[]).find((entry) => entry.name === name);
  if (!option) return res.status(400).json({ success: false, error: "Sandbox option is not available in this server." });
  const value = req.body?.value;
  const numeric = ["number", "integer", "enum"].includes(option.type);
  const valid = numeric
    ? typeof value === "number" && Number.isFinite(value) && (option.type === "number" || Number.isInteger(value)) && (option.min == null || value >= option.min) && (option.max == null || value <= option.max)
    : typeof value === option.type && (typeof value !== "string" || value.length <= 10000);
  if (!valid) return res.status(400).json({ success: false, error: "Invalid value for this sandbox option." });
  const saved = await persistSandboxOption(name, value);
  let applied = false, warning: string | undefined;
  try {
    const result = await game().sendCommand("setSandboxOption", { name, value });
    applied = result.data?.applied === true && result.data?.verified === true && result.data?.value === value;
    if (!applied) warning = "The game did not confirm this value. Restart the server to load the saved setting.";
  } catch (error: any) { warning = error.message; }
  res.json({ success: true, data: { name, value, ...saved, applied, restartRequired: true, ...(warning ? { warning } : {}) } });
}));
router.get("/catalog/items", route(async (_req, res) => {
  const catalog = await getSetting("itemCatalog");
  res.json(catalog || { items: [], count: 0, scannedAt: null });
}));
router.post("/catalog/items/refresh", route(async (_req, res) => {
  const result = await game().sendCommand("getItemCatalog");
  const catalog = { items: result.data.items, count: result.data.items.length, scannedAt: new Date().toISOString() };
  await setSetting("itemCatalog", catalog);
  res.json(catalog);
}));
export default router;
