import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createServer } from "../database/init.ts";
import { handleApiRequest } from "../http/apiDispatcher.ts";
import {
  removeServerRuntime,
  setPanelRuntime,
  setServerRuntime,
} from "../utils/panelRuntime.ts";
import { requireServerId } from "../utils/serverScope.ts";

const roots: string[] = [];
const runtimeIds: string[] = [];

afterEach(() => {
  for (const id of runtimeIds.splice(0)) removeServerRuntime(id);
  setPanelRuntime({});
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function integrationFor(serverId: string, liveFailure: boolean) {
  return {
    snapshot: { session: `${serverId}-boot` },
    isConnected: () => true,
    sendCommand: async (action: string, args: Record<string, unknown> = {}) => {
      expect(requireServerId()).toBe(serverId);
      if (action === "getAllSandboxOptions") {
        return {
          success: true,
          data: {
            options: {
              General: [{ name: "Zombies", type: "integer", value: 2, min: 1, max: 5 }],
            },
          },
        };
      }
      expect(action).toBe("setSandboxOption");
      if (liveFailure) throw new Error("Game command timed out");
      return {
        success: true,
        data: { name: args.name, value: args.value, applied: true, verified: true },
      };
    },
  };
}

describe("profile-scoped game integration sandbox route", () => {
  it("persists settings per profile and reports a failed live apply without losing the saved value", async () => {
    const directories = ["alpha", "beta"].map((name) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `argus-sandbox-${name}-`));
      roots.push(directory);
      fs.writeFileSync(path.join(directory, `${name}_SandboxVars.lua`), "SandboxVars = { Zombies = 2, }\n");
      return directory;
    });
    const [alpha, beta] = await Promise.all([
      createServer({ name: "Alpha", serverName: "alpha", serverConfigPath: directories[0] }),
      createServer({ name: "Beta", serverName: "beta", serverConfigPath: directories[1] }),
    ]);
    runtimeIds.push(alpha.id, beta.id);
    setPanelRuntime({
      authService: {
        authenticateApiRequest: async () => ({ ok: true, user: { userId: "admin", role: "admin" } }),
      },
    });
    setServerRuntime(alpha.id, { gameIntegration: integrationFor(alpha.id, true) });
    setServerRuntime(beta.id, { gameIntegration: integrationFor(beta.id, false) });

    const responses = await Promise.all([
      [alpha, 3],
      [beta, 4],
    ].map(([server, value]) => handleApiRequest(new Request(
      `http://panel.test/api/servers/${server.id}/game-integration/sandbox/options/Zombies`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      },
    ))));

    const bodies = await Promise.all(responses.map(async (response) => {
      expect(response?.status).toBe(200);
      return response!.json();
    }));
    expect(bodies[0]).toMatchObject({
      success: true,
      data: { name: "Zombies", value: 3, persisted: true, applied: false, restartRequired: true },
    });
    expect(bodies[0].data.warning).toContain("timed out");
    expect(bodies[1]).toMatchObject({
      success: true,
      data: { name: "Zombies", value: 4, persisted: true, applied: true, restartRequired: true },
    });
    expect(fs.readFileSync(path.join(directories[0], "alpha_SandboxVars.lua"), "utf8"))
      .toContain("Zombies = 3");
    expect(fs.readFileSync(path.join(directories[1], "beta_SandboxVars.lua"), "utf8"))
      .toContain("Zombies = 4");
  });
});
