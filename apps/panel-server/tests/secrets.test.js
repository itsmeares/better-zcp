import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { readSecret } from "../utils/secrets.js";
import { getSteamApiKey } from "../services/steamApiKey.js";

const savedEnvironment = {
  RCON_PASSWORD: process.env.RCON_PASSWORD,
  RCON_PASSWORD_FILE: process.env.RCON_PASSWORD_FILE,
  STEAM_API_KEY: process.env.STEAM_API_KEY,
  STEAM_API_KEY_FILE: process.env.STEAM_API_KEY_FILE,
};

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("deployment secrets", () => {
  it("prefers a Docker secret file and removes its trailing newline", () => {
    const secretPath = path.join(os.tmpdir(), `panel-secret-${Date.now()}`);
    fs.writeFileSync(secretPath, "file-secret\n");
    process.env.RCON_PASSWORD = "environment-secret";
    process.env.RCON_PASSWORD_FILE = secretPath;

    try {
      expect(readSecret("RCON_PASSWORD")).toBe("file-secret");
    } finally {
      fs.rmSync(secretPath, { force: true });
    }
  });

  it("uses STEAM_API_KEY from the deployment environment", async () => {
    process.env.STEAM_API_KEY = "environment-steam-key";
    delete process.env.STEAM_API_KEY_FILE;

    await expect(getSteamApiKey()).resolves.toBe("environment-steam-key");
  });

  it("uses STEAM_API_KEY from a Docker secret file", async () => {
    const secretPath = path.join(os.tmpdir(), `steam-secret-${Date.now()}`);
    fs.writeFileSync(secretPath, "file-steam-key\n");
    process.env.STEAM_API_KEY = "environment-steam-key";
    process.env.STEAM_API_KEY_FILE = secretPath;

    try {
      await expect(getSteamApiKey()).resolves.toBe("file-steam-key");
    } finally {
      fs.rmSync(secretPath, { force: true });
    }
  });
});
