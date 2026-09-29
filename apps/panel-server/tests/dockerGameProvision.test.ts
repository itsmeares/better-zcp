import { afterEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DockerClient } from "../services/dockerClient.ts";
import { resolveDockerHostSignal } from "../services/managedContainer.ts";

const profile = {
  id: "server-a",
  serverName: "World A",
  serverPort: 16261,
  dockerContainerName: "zomboid-game-server-a",
};

describe.skipIf(process.platform === "win32")("bundled game provisioning", () => {
  let daemon: http.Server | null = null;
  let root = "";
  const previousKind = process.env.PANEL_DOCKER_INSTALL_KIND;
  const previousHostname = process.env.HOSTNAME;

  afterEach(async () => {
    if (daemon) await new Promise<void>((resolve) => daemon!.close(() => resolve()));
    if (root) fs.rmSync(root, { recursive: true, force: true });
    daemon = null;
    root = "";
    if (previousKind === undefined) delete process.env.PANEL_DOCKER_INSTALL_KIND;
    else process.env.PANEL_DOCKER_INSTALL_KIND = previousKind;
    if (previousHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = previousHostname;
  });

  it("creates one stopped game with the panel's existing volumes, network, and both profile ports", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-game-provision-"));
    const socketPath = path.join(root, "docker.sock");
    let created: Record<string, any> | null = null;
    let createCount = 0;
    let panelImage = "sha256:first";
    let gameImage = "";
    let inspectionFails = false;
    let unmanaged = false;
    process.env.PANEL_DOCKER_INSTALL_KIND = "split";
    process.env.HOSTNAME = "panel123";
    daemon = http.createServer((request, response) => {
      if (request.url === "/containers/panel123/json") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          Image: panelImage,
          Config: { Image: "zomboid-panel-allinone:latest" },
          Mounts: [
            { Type: "volume", Name: "ctx_pz-server", Destination: "/pz-server" },
            { Type: "volume", Name: "ctx_zomboid-data", Destination: "/zomboid" },
          ],
          NetworkSettings: { Networks: { ctx_default: {} } },
        }));
        return;
      }
      if (request.url === "/containers/zomboid-game-server-a/json") {
        if (inspectionFails) { response.writeHead(500); response.end(); return; }
        if (!created) { response.writeHead(404); response.end(); return; }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ Image: gameImage, State: { Running: false }, Config: { Labels: unmanaged ? {} : created.Labels } }));
        return;
      }
      if (request.method === "DELETE" && request.url === "/containers/zomboid-game-server-a") {
        created = null;
        response.writeHead(204); response.end();
        return;
      }
      if (request.url === "/containers/create?name=zomboid-game-server-a") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          created = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          gameImage = panelImage;
          createCount++;
          response.setHeader("Content-Type", "application/json");
          response.end('{"Id":"game123"}');
        });
        return;
      }
      response.writeHead(404); response.end();
    });
    await new Promise<void>((resolve) => daemon!.listen(socketPath, resolve));

    const client = new DockerClient({ socketPath, enabled: true });
    await client.ensureBundledGameContainer(profile);
    await client.ensureBundledGameContainer(profile);

    expect(createCount).toBe(1);
    expect(created?.User).toBe("1000:1000");
    expect(created?.Entrypoint).toEqual(["/bin/bash", "/pz-server/start-server_World A.sh"]);
    expect(created?.HostConfig.Binds).toEqual(["ctx_pz-server:/pz-server:rw", "ctx_zomboid-data:/zomboid:rw"]);
    expect(created?.HostConfig.NetworkMode).toBe("ctx_default");
    expect(created?.HostConfig.PortBindings).toEqual({
      "16261/udp": [{ HostPort: "16261" }],
      "16262/udp": [{ HostPort: "16262" }],
    });
    expect(created?.Labels).toMatchObject({ "zomboid-panel.managed": "true", "zomboid-panel.game-id": "server-a" });

    panelImage = "sha256:second";
    await client.ensureBundledGameContainer(profile);
    expect(createCount).toBe(2);
    expect(gameImage).toBe(panelImage);

    inspectionFails = true;
    expect(await resolveDockerHostSignal({ ...profile, installPath: "/pz-server", zomboidDataPath: "/zomboid" }, client))
      .toEqual({ running: false, scanFailed: true });
    await expect(client.ensureBundledGameContainer(profile)).rejects.toThrow(/cannot inspect/i);

    inspectionFails = false;
    unmanaged = true;
    expect(await resolveDockerHostSignal({ ...profile, installPath: "/pz-server", zomboidDataPath: "/zomboid" }, client))
      .toEqual({ running: false, scanFailed: true });
  });
});
