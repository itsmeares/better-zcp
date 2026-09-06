import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import net from "net";
import { setupHttpsServer, isHttpsServerActive } from "../index.js";


const serversToClose = [];

afterEach(async () => {
  await Promise.all(
    serversToClose.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          if (server.listening) server.close(() => resolve());
          else resolve();
        }),
    ),
  );
});

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

describe("setupHttpsServer -- boot must never crash the process", () => {
  it("returns null and does nothing when HTTPS is disabled", () => {
    const result = setupHttpsServer({
      httpsEnabled: false,
      httpsPort: 3443,
      customKeyPath: "",
      customCertPath: "",
    });
    expect(result).toBeNull();
  });

  it("a directory as the custom cert path does NOT crash -- falls back to self-signed and HTTPS still comes up", async () => {
    const port = await getFreePort();
    let server;
    expect(() => {
      server = setupHttpsServer({
        httpsEnabled: true,
        httpsPort: port,
        customKeyPath: process.cwd(),
        customCertPath: process.cwd(),
      });
    }).not.toThrow();

    expect(server).not.toBeNull();
    serversToClose.push(server);

    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    expect(server.listening).toBe(true);
  });

  it("a colliding httpsPort does NOT crash -- HTTPS fails closed (server nulls itself out) instead of taking the process down", async () => {
    const blocker = net.createServer();
    serversToClose.push(blocker);
    const port = await new Promise((resolve) => {
      blocker.listen(0, () => resolve(blocker.address().port));
    });

    let server;
    expect(() => {
      server = setupHttpsServer({
        httpsEnabled: true,
        httpsPort: port,
        customKeyPath: "",
        customCertPath: "",
      });
    }).not.toThrow();

    expect(server).not.toBeNull();

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("expected an 'error' event, none fired")),
        2000,
      );
      server.once("error", (err) => {
        clearTimeout(timeout);
        expect(err.code).toBe("EADDRINUSE");
        resolve();
      });
    });
    expect(server.listening).toBe(false);
    expect(isHttpsServerActive()).toBe(false);
  });

  it("a custom cert path that is a real, readable file but not a valid certificate does NOT crash -- fails closed instead of throwing out of https.createServer()", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-badcert-"));
    const keyPath = path.join(tmpDir, "not-a-key.pem");
    const certPath = path.join(tmpDir, "not-a-cert.pem");
    fs.writeFileSync(keyPath, "this is not a PEM key\n");
    fs.writeFileSync(certPath, "this is not a PEM cert\n");

    let server;
    try {
      expect(() => {
        server = setupHttpsServer({
          httpsEnabled: true,
          httpsPort: 3443,
          customKeyPath: keyPath,
          customCertPath: certPath,
        });
      }).not.toThrow();
      expect(server === null || server.listening === false).toBe(true);
      if (server && server.listening) serversToClose.push(server);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("an out-of-range httpsPort does NOT crash -- fails closed synchronously", () => {
    let server;
    expect(() => {
      server = setupHttpsServer({
        httpsEnabled: true,
        httpsPort: 999999,
        customKeyPath: "",
        customCertPath: "",
      });
    }).not.toThrow();
    if (server) serversToClose.push(server);
    expect(server === null || server.listening === false).toBe(true);
  });

  it("a genuinely valid config still brings HTTPS up -- the fix must not just disable the feature", async () => {
    const port = await getFreePort();

    const server = setupHttpsServer({
      httpsEnabled: true,
      httpsPort: port,
      customKeyPath: "",
      customCertPath: "",
    });

    expect(server).not.toBeNull();
    serversToClose.push(server);

    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    expect(server.listening).toBe(true);
    expect(server.address().port).toBe(port);
  });
});
