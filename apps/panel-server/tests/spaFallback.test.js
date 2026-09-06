import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { sendClientIndex } from "../index.js";

let temporaryRoot;
let server;

describe("SPA fallback", () => {
  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    if (temporaryRoot) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      temporaryRoot = null;
    }
  });

  it("serves the embedded index from hidden parent directories", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-spa-fallback-"));
    const clientDistPath = path.join(
      temporaryRoot,
      ".embedded-client",
      ".zomboid-panel-client-test",
    );
    fs.mkdirSync(clientDistPath, { recursive: true });
    fs.writeFileSync(
      path.join(clientDistPath, "index.html"),
      "<!doctype html><title>panel</title>",
    );

    const app = express();
    app.get("/players", (req, res) => {
      sendClientIndex(res, clientDistPath, (error) => {
        if (error) res.status(500).send("Page not available");
      });
    });
    server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });

    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/players`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>panel</title>");
  });
});