import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  mapSteamServer,
} from "../routes/serverFinder.js";
import { readServerIniSettings } from "../services/mountDiscovery.js";

let temporaryRoot;

afterEach(() => {
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = null;
});

describe("server finder metadata mapping", () => {
  it("preserves an explicit false dedicated flag", () => {
    expect(
      mapSteamServer({
        addr: "203.0.113.10:16261",
        dedicated: false,
        gametype: "pvp;VERSION:42.13",
      }).dedicated,
    ).toBe(false);
  });

  it("falls back when Steam provides an invalid address port", () => {
    expect(
      mapSteamServer({
        addr: "203.0.113.10:not-a-port",
        gameport: 16262,
      }).port,
    ).toBe(16262);
  });
});

describe("discovered INI port parsing", () => {
  function writeIni(contents) {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pz-discovery-"));
    const serverDir = path.join(temporaryRoot, "Server");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, "DoomerZ.ini"), contents);
    return temporaryRoot;
  }

  it("keeps defaults only when ports are absent", () => {
    const dataPath = writeIni("RCONPassword=secret\n");
    expect(readServerIniSettings(dataPath, "DoomerZ")).toMatchObject({
      rconPort: 27015,
      serverPort: 16261,
    });
  });

  it("rejects an explicitly malformed port instead of using a default", () => {
    const dataPath = writeIni("RCONPassword=secret\nRCONPort=not-a-port\n");
    expect(readServerIniSettings(dataPath, "DoomerZ")).toBeNull();
  });
});