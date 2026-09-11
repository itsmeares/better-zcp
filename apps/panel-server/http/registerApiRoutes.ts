import type { Express } from "express";
import oidcRoutes from "../routes/oidc.ts";
import serverRoutes from "../routes/server.ts";
import serversRoutes from "../routes/servers.ts";
import serverFilesRoutes from "../routes/serverFiles.ts";
import modsRoutes from "../routes/mods.ts";
import chunksRoutes from "../routes/chunks.ts";
import debugRoutes from "../routes/debug.ts";
import panelBridgeRoutes from "../routes/panelBridge.ts";
import backupRoutes from "../routes/backup.ts";
import mapProxyRoutes from "../routes/mapProxy.ts";

export function registerApiRoutes(app: Express): void {
  app.use("/api/auth/oidc", oidcRoutes);

  app.use("/api/server", serverRoutes);
  app.use("/api/servers", serversRoutes);
  app.use("/api/server-files", serverFilesRoutes);
  app.use("/api/mods", modsRoutes);
  app.use("/api/chunks", chunksRoutes);
  app.use("/api/debug", debugRoutes);
  app.use("/api/panel-bridge", panelBridgeRoutes);
  app.use("/api/backup", backupRoutes);
  app.use("/api/map", mapProxyRoutes);
}
