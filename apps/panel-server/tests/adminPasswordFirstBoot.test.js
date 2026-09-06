import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createServer } from "../database/init.js";
import { generateStartupScripts, isFirstBootMissingAdminPassword } from "../routes/server.js";

// 2026-08-26, two real Discord users (Stefa, Elch): a server created
// through the setup wizard could not start at all. PZ's console showed
// "Command line admin password: null" then "Enter new administrator
// password:" then died with NoSuchElementException at Scanner.nextLine --
// the panel launched the server with no -adminpassword flag and no
// interactive stdin for PZ to fall back to.
//
// ROOT CAUSE: server/database/init.js's createServer() built the persisted
// record from an explicit field-by-field object literal that never named
// adminPassword -- servers.js's POST / forwarded it correctly, but it was
// dropped one layer down, on every server ever created through the panel.
// updateServer() never had this bug (it spreads `updates` generically), which
// is exactly why re-saving the admin password after the fact (the users' own
// workaround) was the only thing that ever worked.
//
// This file pins the fix at three levels: the DB layer no longer drops the
// field, generateStartupScripts() puts -adminpassword in the actual launch
// args once it has a real value to work with, and the NEW loud-failure
// guard (isFirstBootMissingAdminPassword) refuses to start a server that
// would hit this exact crash, without over-refusing an already-booted one.
describe("createServer() persists adminPassword (database/init.js)", () => {
  it("a server created with an admin password has it on the returned record, not silently dropped", async () => {
    const server = await createServer({
      name: "AdminPwTest",
      serverName: "AdminPwTest",
      installPath: "/srv/pz",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      rconPassword: "rconpw",
      adminPassword: "supersecret123",
      serverPort: 16261,
    });
    expect(server.adminPassword).toBe("supersecret123");
  });

  it("a server created with no admin password stores an empty string, not undefined -- isFirstBootMissingAdminPassword below relies on this being falsy either way", async () => {
    const server = await createServer({
      name: "NoAdminPwTest",
      serverName: "NoAdminPwTest",
      installPath: "/srv/pz2",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      rconPassword: "rconpw",
      serverPort: 16261,
    });
    expect(server.adminPassword).toBe("");
  });
});

describe("generateStartupScripts() -- the launch args regression pin", () => {
  it("includes -adminpassword in BOTH the .bat and .sh when a password is set", () => {
    const scripts = generateStartupScripts({
      installPath: "C:/servers/pz",
      serverName: "MyServer",
      minMemory: 2,
      maxMemory: 4,
      adminPassword: "hunter2",
      serverPort: 16261,
    });
    expect(scripts.bat).toContain('-adminpassword "hunter2"');
    expect(scripts.sh).toContain('-adminpassword "hunter2"');
  });

  it("omits -adminpassword entirely when the password is empty -- this is the exact shape that used to crash silently, now caught by the guard below instead of shipped unnoticed", () => {
    const scripts = generateStartupScripts({
      installPath: "C:/servers/pz",
      serverName: "MyServer",
      minMemory: 2,
      maxMemory: 4,
      adminPassword: "",
      serverPort: 16261,
    });
    expect(scripts.bat).not.toContain("-adminpassword");
    expect(scripts.sh).not.toContain("-adminpassword");
  });
});

describe("isFirstBootMissingAdminPassword() -- the loud-failure guard", () => {
  let tmpRoot;

  function withSaveDir(zomboidDataPath, serverName) {
    fs.mkdirSync(path.join(zomboidDataPath, "Saves", "Multiplayer", serverName), { recursive: true });
  }

  it("true: no admin password AND the server has never booted (no save directory yet)", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-firstboot-"));
    try {
      const activeServer = {
        serverName: "Fresh",
        zomboidDataPath: tmpRoot,
        adminPassword: "",
      };
      expect(isFirstBootMissingAdminPassword(activeServer)).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("false: no admin password, but the server HAS already booted (save directory exists) -- must not regress an already-working server", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-firstboot-"));
    try {
      withSaveDir(tmpRoot, "AlreadyRan");
      const activeServer = {
        serverName: "AlreadyRan",
        zomboidDataPath: tmpRoot,
        adminPassword: "",
      };
      expect(isFirstBootMissingAdminPassword(activeServer)).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("false: an admin password IS set, first boot or not", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-firstboot-"));
    try {
      const activeServer = {
        serverName: "Fresh",
        zomboidDataPath: tmpRoot,
        adminPassword: "hunter2",
      };
      expect(isFirstBootMissingAdminPassword(activeServer)).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("false: a remote server -- this class of crash is local-process-only, and a remote server is refused for a different reason earlier in the route", () => {
    expect(
      isFirstBootMissingAdminPassword({
        serverName: "Remote",
        zomboidDataPath: "/anything",
        adminPassword: "",
        isRemote: true,
      }),
    ).toBe(false);
  });

  it("false: no active server, or a record missing serverName/zomboidDataPath -- nothing to check yet, not a reason to refuse", () => {
    expect(isFirstBootMissingAdminPassword(null)).toBe(false);
    expect(isFirstBootMissingAdminPassword({ adminPassword: "" })).toBe(false);
    expect(
      isFirstBootMissingAdminPassword({ serverName: "X", adminPassword: "" }),
    ).toBe(false);
  });
});
